/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";
import type { RunningGame } from "@vencord/discord-types";
import { findByPropsLazy, findStoreLazy } from "@webpack";
import { RestAPI } from "@webpack/common";

const SCIENCE_URL = "/science";
const ME_URL = "/users/@me";
const TOKEN_MAX_AGE = 12 * 60 * 60 * 1_000;
// Discord's RunningGameHeartbeatManager reports every 5 minutes, each heartbeat carrying only the time since the last one
export const HEARTBEAT_INTERVAL_MS = 5 * 60_000;
const EVENTS_PER_REQUEST = 100;

const SuperProperties: { getSuperProperties(): Record<string, any>; } = findByPropsLazy("getSuperProperties");
const RunningGameStore: {
    getRunningGames(): DetectedGame[];
    getGamesSeen(includeHidden?: boolean): DetectedGame[];
} = findStoreLazy("RunningGameStore");
const logger = new Logger("GameSessionSpoofer");

type DetectedGame = RunningGame & { executableFingerprint?: string; };

export interface CreditableGame {
    id: string;
    name: string;
    exeName: string;
}

export interface PlaytimeCredit {
    gameSession: string;
    creditedUntil: number;
    launched: boolean;
    finished: boolean;
}

let analyticsToken = "";
let analyticsTokenFetchedAt = 0;
let sequence = 0;
let reports: Promise<void> = Promise.resolve();
const fingerprints = new Map<string, string>();

export function fingerprintFor(gameId: string): string {
    const known = fingerprints.get(gameId);
    if (known != null) return known;

    let detected: DetectedGame[] = [];
    try {
        detected = [...RunningGameStore.getRunningGames(), ...RunningGameStore.getGamesSeen(true)];
    } catch (error) {
        logger.warn("Could not read Discord's detected games", error);
    }

    const fingerprint = detected.find(game => game.id === gameId && game.executableFingerprint)?.executableFingerprint ?? "";
    if (fingerprint !== "") fingerprints.set(gameId, fingerprint);

    return fingerprint;
}

async function getAnalyticsToken(): Promise<string> {
    if (analyticsToken !== "" && Date.now() - analyticsTokenFetchedAt < TOKEN_MAX_AGE) return analyticsToken;

    const { body } = await RestAPI.get({ url: ME_URL, query: { with_analytics_token: true } });
    if (typeof body?.analytics_token !== "string") throw new Error("Discord returned no analytics_token");

    analyticsToken = body.analytics_token;
    analyticsTokenFetchedAt = Date.now();

    return analyticsToken;
}

function clientSession(): { heartbeatSession: string; launchSignature: string; locale: string; } {
    let properties: Record<string, any> = {};
    try {
        properties = SuperProperties.getSuperProperties() ?? {};
    } catch (error) {
        logger.warn("Could not read the client's super properties", error);
    }

    return {
        heartbeatSession: properties.client_heartbeat_session_id ?? crypto.randomUUID(),
        launchSignature: properties.launch_signature ?? crypto.randomUUID(),
        locale: properties.system_locale ?? "en-US"
    };
}

function buildLaunch(game: CreditableGame, fingerprint: string, at: number): Record<string, any> {
    const { heartbeatSession, launchSignature, locale } = clientSession();

    const properties: Record<string, any> = {
        client_track_timestamp: at,
        client_heartbeat_session_id: heartbeatSession,
        event_sequence_number: ++sequence,
        game: game.name,
        game_id: game.id,
        verified: true,
        elevated: false,
        is_launcher: false,
        game_platform: "desktop",
        detection_method: "verified_game",
        is_overlay_enabled: false,
        is_overlay_game_enabled: true,
        is_overlay_game_source: "OOP_DEFAULT_DATABASE",
        fullscreen_type: "UNKNOWN",
        hardware_display_count: 1,
        overlay_method: "Disabled",
        activity_status_enabled: true,
        activity_status_shared_guilds: [],
        current_user_status: "online",
        game_detection_enabled: true,
        executable_path: game.exeName,
        voice_channel_id: null,
        voice_channel_type: null,
        voice_channel_bitrate: null,
        voice_channel_guild_id: null,
        hidden_by_distributor: false,
        game_metadata: null,
        client_performance_cpu: null,
        client_performance_memory: null,
        cpu_core_count: null,
        accessibility_features: 0,
        rendered_locale: locale,
        launch_signature: launchSignature,
        client_rtc_state: null,
        client_app_state: "focused",
        client_send_timestamp: at
    };

    if (fingerprint !== "") properties.executable_fingerprint = fingerprint;

    return { type: "launch_game", properties };
}

function buildHeartbeat(game: CreditableGame, durationMs: number, gameSession: string, initial: boolean, final: boolean, at: number): Record<string, any> {
    const { heartbeatSession, launchSignature } = clientSession();

    return {
        type: "running_game_heartbeat",
        properties: {
            client_track_timestamp: at,
            client_heartbeat_session_id: heartbeatSession,
            event_sequence_number: ++sequence,
            game_id: game.id,
            game_name: game.name,
            game_metadata: null,
            game_executable: game.exeName,
            game_detection_enabled: true,
            initial_heartbeat: initial,
            final_heartbeat: final,
            game_session_id: gameSession,
            duration_tracked_ms: Math.round(durationMs),
            rtc_connection_id: null,
            media_session_id: null,
            discord_window_state: "focused",
            launch_signature: launchSignature,
            client_app_state: "focused",
            client_send_timestamp: at
        }
    };
}

export function newCredit(startedAt: number): PlaytimeCredit {
    return { gameSession: crypto.randomUUID(), creditedUntil: startedAt, launched: false, finished: false };
}

async function sendCredit(game: CreditableGame, credit: PlaytimeCredit, final: boolean): Promise<void> {
    if (credit.finished) return;

    const until = Date.now();
    const events: Record<string, any>[] = [];
    let at = credit.creditedUntil;

    if (!credit.launched) {
        events.push(
            buildLaunch(game, fingerprintFor(game.id), at),
            buildHeartbeat(game, 0, credit.gameSession, true, false, at)
        );
    }

    // Backdated or missed time goes out as native-sized slices instead of one oversized heartbeat
    while (until - at > HEARTBEAT_INTERVAL_MS) {
        at += HEARTBEAT_INTERVAL_MS;
        events.push(buildHeartbeat(game, HEARTBEAT_INTERVAL_MS, credit.gameSession, false, false, at));
    }
    if (final || until > at) events.push(buildHeartbeat(game, until - at, credit.gameSession, false, final, until));

    const token = await getAnalyticsToken();
    for (let index = 0; index < events.length; index += EVENTS_PER_REQUEST) {
        await RestAPI.post({ url: SCIENCE_URL, body: { token, events: events.slice(index, index + EVENTS_PER_REQUEST) } });
    }

    logger.debug(`Credited ${Math.round((until - credit.creditedUntil) / 60_000)}m of ${game.name}`);
    credit.launched = true;
    credit.creditedUntil = until;
    credit.finished = final;
}

/** Reports the time since the last report, one request at a time so slices never overlap. */
export function reportPlaytime(game: CreditableGame, credit: PlaytimeCredit, final = false): Promise<void> {
    const report = reports.then(() => sendCredit(game, credit, final));
    reports = report.catch(() => { });
    return report;
}
