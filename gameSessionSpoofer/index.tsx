/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { definePluginSettings } from "@api/Settings";
import { UserAreaButton, UserAreaButtonFactory, UserAreaRenderProps } from "@api/UserArea";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { Heading } from "@components/Heading";
import { ChevronSmallDownIcon, ChevronSmallUpIcon, DeleteIcon, GameControllerIcon } from "@components/Icons";
import { Notice } from "@components/Notice";
import { Paragraph } from "@components/Paragraph";
import { EquicordDevs } from "@utils/constants";
import { classNameFactory } from "@utils/css";
import { Logger } from "@utils/Logger";
import { classes, sleep } from "@utils/misc";
import { useForceUpdater } from "@utils/react";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import type { Application, RenderModalProps, RunningGame } from "@vencord/discord-types";
import { findByPropsLazy, findStoreLazy, onceReady } from "@webpack";
import { ApplicationAssetUtils, ApplicationStore, Checkbox, Constants, FluxDispatcher, IconUtils, Modal, openModal, RestAPI, showToast, TextInput, useEffect, useMemo, useState, useStateFromStores } from "@webpack/common";
import type { JSX } from "react";

import type { GameWindow } from "./native";
import { fingerprintFor, HEARTBEAT_INTERVAL_MS, newCredit, PlaytimeCredit, reportPlaytime } from "./science";

const cl = classNameFactory("vc-game-session-spoofer-");
const Native = VencordNative.pluginHelpers.GameSessionSpoofer as PluginNative<typeof import("./native")>;

const DETECTABLE_APPS_URL = "https://discord.com/api/v10/applications/detectable";
const MAX_RESULTS = 30;
const MAX_MINUTES = 1440;

const SelfPresenceStore: { getActivities(): { application_id?: string; }[]; } = findStoreLazy("SelfPresenceStore");
const { fetchApplication }: { fetchApplication: (id: string) => Promise<Application | null>; } = findByPropsLazy("fetchApplication");
const DesktopSources: { getDesktopSourceFromPid(pid: number): string | null; } = findByPropsLazy("getDesktopSourceFromPid", "getPidFromDesktopSource");
const logger = new Logger("GameSessionSpoofer");

interface DetectableExecutable {
    name: string;
    os?: string;
    is_launcher?: boolean;
}

interface DetectableApp {
    id: string;
    name: string;
    executables?: DetectableExecutable[];
}

interface GameMediaAsset {
    type: "hash" | "url";
    value: string;
}

interface GameRecord {
    id: string;
    media?: {
        icon?: GameMediaAsset;
        cover?: GameMediaAsset;
        cover_url?: string;
    };
}

interface GameImage {
    activityImage: string;
    url: string;
}

interface SpoofedGame extends Omit<RunningGame, "distributor"> {
    id: string;
    pid: number;
    exeName: string;
    pidPath: number[];
    processName: string;
    start: number;
    windowHandle?: string | null;
}

interface QueuedGame {
    id: string;
    name: string;
    exeName: string;
    minutes: number;
}

interface Session {
    game: SpoofedGame;
    endsAt: number;
    credit?: PlaytimeCredit;
}

interface StoredSession {
    game: Pick<SpoofedGame, "id" | "name" | "exeName" | "start">;
    endsAt: number;
    credit?: PlaytimeCredit;
}

let catalogue: Promise<DetectableApp[]> | null = null;
const gameImages = new Map<string, GameImage>();
let session: Session | null = null;
let queue: QueuedGame[] = [];
let stopTimeout: ReturnType<typeof setTimeout> | undefined;
let creditInterval: ReturnType<typeof setInterval> | undefined;
let sessionGeneration = 0;

function loadCatalogue(): Promise<DetectableApp[]> {
    catalogue ??= fetch(DETECTABLE_APPS_URL)
        .then(response => {
            if (!response.ok) throw new Error(`Discord returned ${response.status}`);
            return response.json() as Promise<DetectableApp[]>;
        })
        .then(apps => apps.filter(app => app.id != null && app.name != null))
        .catch(error => {
            catalogue = null;
            throw error;
        });

    return catalogue;
}

function executableFor(app: DetectableApp): string {
    const executables = app.executables ?? [];
    const executable = executables.find(entry => entry.os === "win32" && entry.is_launcher !== true)
        ?? executables.find(entry => entry.os === "win32")
        ?? executables[0];

    return (executable?.name.replace(/^>/, "") ?? `${app.name}.exe`).replace(/^.*[\\/]/, "");
}

function setDebugGame(game: SpoofedGame | null): void {
    FluxDispatcher.dispatch({ type: "RUNNING_GAME_SET_DEBUG_GAME", game });
}

function gameMediaUrl(gameId: string, media?: GameMediaAsset): string | null {
    if (media?.type === "url") return media.value;
    if (media?.type === "hash") return IconUtils.getGameAssetURL({ id: gameId, hash: media.value }) ?? null;
    return null;
}

async function prepareGameImage(game: SpoofedGame): Promise<void> {
    if (gameImages.has(game.id)) return;

    try {
        const response = await RestAPI.get({
            url: Constants.Endpoints.GAMES,
            query: { game_ids: [game.id] }
        });
        const record = (response.body as GameRecord[]).find(record => record.id === game.id);
        const url = gameMediaUrl(game.id, record?.media?.icon)
            ?? gameMediaUrl(game.id, record?.media?.cover)
            ?? record?.media?.cover_url;
        if (url == null) return;

        const activityImage = (await ApplicationAssetUtils.fetchAssetIds(game.id, [url]))[0];
        if (activityImage != null) gameImages.set(game.id, { activityImage, url });
    } catch (error) {
        logger.warn(`Failed to fetch ${game.name}'s game image`, error);
    }
}

function buildGame({ id, name, exeName }: Pick<QueuedGame, "id" | "name" | "exeName">, startedAt: number): SpoofedGame {
    const folder = name.replace(/[<>:"/\\|?*]/g, "").toLowerCase();
    const pid = 0;

    return {
        id,
        name,
        exeName,
        exePath: `c:/program files/${folder}/${exeName}`,
        cmdLine: `c:/program files/${folder}/${exeName}`,
        processName: name,
        pid,
        pidPath: [pid],
        start: startedAt,
        lastFocused: Math.floor(startedAt / 1000),
        lastLaunched: startedAt,
        nativeProcessObserverId: -1,
        hidden: false,
        isLauncher: false,
        elevated: false,
        sandboxed: false
    };
}

function setQueue(next: QueuedGame[]): void {
    queue = next;
    settings.store.queue = next;
}

function persistSession(): void {
    if (session == null) {
        settings.store.session = null;
        return;
    }

    const { game, endsAt, credit } = session;
    settings.store.session = {
        game: {
            id: game.id,
            name: game.name,
            exeName: game.exeName,
            start: game.start
        },
        endsAt,
        credit: credit && { ...credit }
    };
}

function finishCredit({ game, credit }: Session): void {
    if (credit == null || credit.finished) return;

    reportPlaytime(game, credit, true).catch(error => {
        logger.error(`Failed to credit playtime for ${game.name}`, error);
        showToast({ text: `Could not credit your ${game.name} playtime.`, variant: "critical" });
    });
}

function syncCredit(): void {
    const current = session;
    if (current == null) return;

    if (!settings.store.creditPlaytime) {
        finishCredit(current);
        return;
    }

    if (current.credit == null || current.credit.finished) {
        current.credit = newCredit(current.credit?.creditedUntil ?? current.game.start);
    }

    reportPlaytime(current.game, current.credit)
        .then(() => {
            if (session === current) persistSession();
        })
        .catch(error => logger.warn(`Failed to report ${current.game.name}'s playtime, retrying on the next heartbeat`, error));
}

function helperWindow(game: SpoofedGame): GameWindow | null {
    return settings.store.streamWindow ? { title: game.name, imageUrl: gameImages.get(game.id)?.url } : null;
}

// Go Live's stream director only captures running games that carry the HWND of their window
async function attachWindow(game: SpoofedGame): Promise<void> {
    const { pid } = game;
    if (!settings.store.streamWindow) return;

    for (let attempt = 0; attempt < 60; attempt++) {
        if (session?.game !== game || game.pid !== pid) return;

        const handle = DesktopSources.getDesktopSourceFromPid(pid)?.split(":")[1];
        if (handle) {
            const { start } = game;
            game.windowHandle = handle;
            setDebugGame(game);
            game.start = start;
            return;
        }

        await sleep(250);
    }

    logger.warn(`The stream window for ${game.name} never appeared`);
}

function restartHelper(): void {
    const current = session;
    if (current == null || Native == null) return;

    const generation = sessionGeneration;
    Native.startGameProcess(helperWindow(current.game)).then(pid => {
        if (generation !== sessionGeneration) return;

        current.game.pid = pid;
        current.game.pidPath = [pid];
        current.game.windowHandle = null;
        setDebugGame(current.game);
        void attachWindow(current.game);
    }).catch(error => {
        logger.error("Failed to restart the game session process", error);
        showToast({ text: "Could not restart the game session.", variant: "critical" });
    });
}

function applySession(next: Session): void {
    if (session != null) finishCredit(session);

    const { game, endsAt } = next;
    const generation = ++sessionGeneration;

    session = null;
    settings.store.session = null;
    clearTimeout(stopTimeout);
    stopTimeout = undefined;
    setDebugGame(null);

    if (Native == null) {
        logger.error("The native game session helper is unavailable; restart Discord after rebuilding");
        showToast({ text: "Restart Discord before starting a game session.", variant: "critical" });
        return;
    }

    void prepareGameImage(game).then(() => Native.startGameProcess(helperWindow(game))).then(pid => {
        if (generation !== sessionGeneration) return;

        game.pid = pid;
        game.pidPath = [pid];

        if (settings.store.creditPlaytime) fingerprintFor(game.id);

        const { start } = game;
        setDebugGame(game);
        game.start = start;
        setDebugGame(game);

        session = next;
        persistSession();
        syncCredit();
        void attachWindow(game);

        stopTimeout = endsAt === 0 ? undefined : setTimeout(() => advanceQueue(endsAt), endsAt - Date.now());
    }).catch(error => {
        if (generation !== sessionGeneration) return;
        logger.error("Failed to start the game session process", error);
        showToast({ text: "Could not start the game session.", variant: "critical" });
    });
}

function stopSession(): void {
    sessionGeneration++;
    clearTimeout(stopTimeout);
    stopTimeout = undefined;
    settings.store.session = null;
    void Native?.stopGameProcess();

    const finished = session;
    session = null;
    setDebugGame(null);

    if (finished != null) finishCredit(finished);
}

function stopAll(): void {
    setQueue([]);
    stopSession();
}

function advanceQueue(from: number): void {
    while (queue.length > 0) {
        const [next, ...rest] = queue;
        const endsAt = next.minutes === 0 ? 0 : from + next.minutes * 60_000;

        setQueue(rest);

        if (endsAt === 0 || endsAt > Date.now()) {
            applySession({ game: buildGame(next, from), endsAt });
            showToast({ text: `Now playing ${next.name}.`, variant: "success" });
            return;
        }

        from = endsAt;
    }

    const finished = session;
    stopSession();
    if (finished != null) showToast({ text: `Stopped playing ${finished.game.name}.`, variant: "default" });
}

function startNow(entry: QueuedGame, playedForMinutes: number): void {
    const now = Date.now();

    applySession({
        game: buildGame(entry, now - playedForMinutes * 60_000),
        endsAt: entry.minutes === 0 ? 0 : now + entry.minutes * 60_000
    });

    showToast({ text: `Now playing ${entry.name}.`, variant: "success" });
}

function moveQueued(index: number, offset: number): void {
    const target = index + offset;
    if (target < 0 || target >= queue.length) return;

    const next = [...queue];
    [next[index], next[target]] = [next[target], next[index]];
    setQueue(next);
}

function pickShuffledGames(apps: DetectableApp[], count: number, minutes: number): QueuedGame[] {
    const pool = [...apps];

    for (let index = 0; index < count; index++) {
        const picked = index + Math.floor(Math.random() * (pool.length - index));
        [pool[index], pool[picked]] = [pool[picked], pool[index]];
    }

    return pool.slice(0, count).map(app => ({
        id: app.id,
        name: app.name,
        exeName: executableFor(app),
        minutes
    }));
}

function formatDuration(ms: number): string {
    const totalMinutes = Math.max(0, Math.round(ms / 60_000));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    return hours === 0 ? `${minutes}m` : `${hours}h ${minutes}m`;
}

function formatMinutes(minutes: number): string {
    return minutes === 0 ? "until stopped" : formatDuration(minutes * 60_000);
}

function GameIcon({ game }: { game: SpoofedGame; }) {
    const application = useStateFromStores([ApplicationStore], () => ApplicationStore.getApplication(game.id));

    useEffect(() => {
        if (application != null) return;

        void fetchApplication(game.id).catch(error => logger.error(`Failed to fetch ${game.name}'s application icon`, error));
    }, [application, game.id, game.name]);

    const src = application?.icon
        ? IconUtils.getApplicationIconURL({ id: application.id, icon: application.icon })
        : gameImages.get(game.id)?.url;
    if (src == null) return null;

    return (
        <img
            className={cl("session-icon")}
            src={src}
            alt={`${game.name} icon`}
        />
    );
}

function parseDuration(value: string): number | null {
    const input = value.trim().toLowerCase();
    const match = /^(?:(\d+)\s*h(?:(?:ou)?rs?)?)?\s*(?:(\d+)\s*m(?:in(?:ute)?s?)?)?$/.exec(input);

    let minutes: number;
    if (/^\d+$/.test(input)) minutes = Number(input);
    else if (match != null && (match[1] != null || match[2] != null)) minutes = Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0);
    else return null;

    return minutes <= MAX_MINUTES ? minutes : null;
}

function queueStartsIn(index: number): number | null {
    if (session == null || session.endsAt === 0) return null;

    let at = session.endsAt;
    for (let before = 0; before < index; before++) {
        if (queue[before].minutes === 0) return null;
        at += queue[before].minutes * 60_000;
    }

    return at - Date.now();
}

function SpooferPanel(): JSX.Element {
    const [apps, setApps] = useState<DetectableApp[] | null>(null);
    const [query, setQuery] = useState("");
    const [selected, setSelected] = useState<DetectableApp | null>(null);
    const [duration, setDuration] = useState("60");
    const [playedFor, setPlayedFor] = useState("0");
    const [shuffleCount, setShuffleCount] = useState("5");
    const [queueExpanded, setQueueExpanded] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const { creditPlaytime: creditPlaytimeEnabled, streamWindow } = settings.use(["creditPlaytime", "streamWindow"]);
    const forceUpdate = useForceUpdater();

    const published = useStateFromStores([SelfPresenceStore], () =>
        SelfPresenceStore.getActivities().some(activity => activity.application_id === session?.game.id));

    useEffect(() => {
        loadCatalogue().then(setApps, cause => setError(`Could not load Discord's game list: ${cause.message}`));
    }, []);

    useEffect(() => {
        const interval = setInterval(forceUpdate, 1_000);
        return () => clearInterval(interval);
    }, []);

    const results = useMemo(() => {
        const needle = query.trim().toLowerCase();
        if (apps == null || needle.length < 2) return [];

        return apps
            .filter(app => app.name.toLowerCase().includes(needle))
            .sort((left, right) =>
                Number(right.name.toLowerCase().startsWith(needle)) - Number(left.name.toLowerCase().startsWith(needle))
                || left.name.localeCompare(right.name))
            .slice(0, MAX_RESULTS);
    }, [apps, query]);

    const minutes = parseDuration(duration);
    const backdate = parseDuration(playedFor);
    const parsedShuffleCount = Number(shuffleCount);
    const validShuffleCount = Number.isInteger(parsedShuffleCount)
        && parsedShuffleCount > 0
        && parsedShuffleCount <= (apps?.length ?? 0)
        ? parsedShuffleCount
        : null;

    const entry = useMemo<QueuedGame | null>(() =>
        selected == null || minutes == null
            ? null
            : { id: selected.id, name: selected.name, exeName: executableFor(selected), minutes },
    [selected, minutes]);

    const queueAcceptsMore = queue.at(-1)?.minutes !== 0;
    const startsQueue = (entry == null || backdate == null) && session == null && queue.length > 0;

    function act(action: () => void) {
        action();
        forceUpdate();
    }

    function clearSelectedGame() {
        setSelected(null);
        setQuery("");
    }

    return (
        <div className={cl("panel")}>
            <Paragraph className={classes(cl("intro"), cl("muted"))}>
                Pick any game Discord can detect and it shows up as your activity without the game running.
            </Paragraph>

            <TextInput
                value={query}
                onChange={value => {
                    setQuery(value);
                    setSelected(null);
                }}
                disabled={apps == null && error == null}
                placeholder={apps == null ? "Loading Discord's game list…" : "Search games"}
            />

            {selected == null && results.length > 0 && (
                <div className={cl("results")}>
                    {results.map(app => (
                        <button
                            key={app.id}
                            className={cl("result")}
                            onClick={() => {
                                setSelected(app);
                                setQuery(app.name);
                            }}
                        >
                            <span className={cl("result-name")}>{app.name}</span>
                            <span className={cl("result-meta")}>{executableFor(app)} · {app.id}</span>
                        </button>
                    ))}
                </div>
            )}

            {selected == null && apps != null && query.trim().length >= 2 && results.length === 0 && (
                <Paragraph className={cl("muted")}>No detectable game matches that name.</Paragraph>
            )}

            <div className={cl("row")}>
                <div className={cl("field")}>
                    <div className={cl("field-copy")}>
                        <Heading tag="h5" className={cl("field-label")}>Set Duration</Heading>
                        <span className={cl("field-hint")}>Format: 60m / 2hr 30m — 0 = infinite</span>
                    </div>
                    <TextInput value={duration} onChange={setDuration} />
                </div>
                <div className={cl("field")}>
                    <div className={cl("field-copy")}>
                        <Heading tag="h5" className={cl("field-label")}>Already played for</Heading>
                    </div>
                    <TextInput value={playedFor} onChange={setPlayedFor} />
                </div>
            </div>

            <div className={cl("shuffle")}>
                <div className={cl("field")}>
                    <div className={cl("field-copy")}>
                        <Heading tag="h5" className={cl("field-label")}>Shuffle count</Heading>
                        <span className={cl("field-hint")}>
                            Input amount of games below, set duration od each game above. (Infinite does not work here obviously)
                        </span>
                    </div>
                    <TextInput
                        value={shuffleCount}
                        onChange={setShuffleCount}
                    />
                </div>
                <Button
                    variant="secondary"
                    disabled={apps == null || minutes == null || minutes === 0 || validShuffleCount == null || !queueAcceptsMore}
                    onClick={() => {
                        if (apps == null || minutes == null || minutes === 0 || validShuffleCount == null || !queueAcceptsMore) return;
                        act(() => setQueue([...queue, ...pickShuffledGames(apps, validShuffleCount, minutes)]));
                    }}
                >
                    Shuffle
                </Button>
            </div>

            <Checkbox
                value={creditPlaytimeEnabled}
                onChange={(_event, checked) => {
                    settings.store.creditPlaytime = checked;
                    syncCredit();
                }}
                type="row"
            >
                <span className={cl("checkbox-label")}>
                    Credit playtime to your profile
                    <span className={cl("muted")}> — reports sessions to Discord's analytics as they play</span>
                </span>
            </Checkbox>

            {creditPlaytimeEnabled && (
                <Paragraph className={cl("muted")}>
                    Playtime is sent every 5 minutes like a real game, and badges only move on Discord's daily analytics
                    cycle. Hours always count; the games played count only does for games this client has actually
                    detected before.
                </Paragraph>
            )}

            <Checkbox
                value={streamWindow}
                onChange={(_event, checked) => {
                    settings.store.streamWindow = checked;
                    restartHelper();
                }}
                type="row"
            >
                <span className={cl("checkbox-label")}>
                    Open a streamable game window
                    <span className={cl("muted")}> — lets Go Live share the spoofed game</span>
                </span>
            </Checkbox>

            {streamWindow && (
                <Paragraph className={cl("muted")}>
                    Join a voice channel, then use the Stream button or pick the game's window under Applications.
                    Discord treats it as streaming the spoofed game. Keep the window unminimized while live.
                </Paragraph>
            )}

            {session != null && (
                <Notice.Positive action={<GameIcon game={session.game} />}>
                    <span className={cl("session-title")}>
                        Playing {session.game.name}
                    </span>
                    <span>
                        {session.endsAt === 0
                            ? `Played for ${formatDuration(Date.now() - session.game.start)}`
                            : `Time remaining ${formatDuration(session.endsAt - Date.now())}`}
                    </span>
                </Notice.Positive>
            )}

            {session != null && !published && (
                <Notice.Warning>
                    Discord publishes only one game at a time and another activity is currently winning. Close your
                    other Rich Presence app, or check that activity sharing is enabled.
                </Notice.Warning>
            )}

            {queue.length > 0 && (
                <div className={cl("queue")}>
                    <div className={cl("queue-header")}>
                        <Heading tag="h5" className={cl("queue-title")}>
                            Up next · {queue.length} queued
                            {queueAcceptsMore && `, ${formatMinutes(queue.reduce((total, queued) => total + queued.minutes, 0))} total`}
                        </Heading>
                        <button
                            className={cl("queue-control")}
                            type="button"
                            aria-expanded={queueExpanded}
                            aria-label={queueExpanded ? "Collapse queue" : "Expand queue"}
                            onClick={() => setQueueExpanded(expanded => !expanded)}
                        >
                            {queueExpanded
                                ? <ChevronSmallUpIcon height={16} width={16} />
                                : <ChevronSmallDownIcon height={16} width={16} />}
                        </button>
                    </div>
                    {queueExpanded && queue.map((queued, index) => {
                        const startsIn = queueStartsIn(index);

                        return (
                            <div key={`${queued.id}-${index}`} className={cl("queue-entry")}>
                                <span className={cl("queue-position")}>{index + 1}</span>
                                <div className={cl("queue-text")}>
                                    <span className={cl("result-name")}>{queued.name}</span>
                                    <span className={cl("result-meta")}>
                                        {formatMinutes(queued.minutes)}
                                        {startsIn != null && ` · starts in ${formatDuration(startsIn)}`}
                                    </span>
                                </div>
                                <button
                                    className={cl("queue-control")}
                                    aria-label={`Move ${queued.name} up`}
                                    disabled={index === 0}
                                    onClick={() => act(() => moveQueued(index, -1))}
                                >
                                    <ChevronSmallUpIcon height={16} width={16} />
                                </button>
                                <button
                                    className={cl("queue-control")}
                                    aria-label={`Move ${queued.name} down`}
                                    disabled={index === queue.length - 1}
                                    onClick={() => act(() => moveQueued(index, 1))}
                                >
                                    <ChevronSmallDownIcon height={16} width={16} />
                                </button>
                                <button
                                    className={cl("queue-control")}
                                    aria-label={`Remove ${queued.name} from the queue`}
                                    onClick={() => act(() => setQueue(queue.filter((_, at) => at !== index)))}
                                >
                                    <DeleteIcon height={16} width={16} />
                                </button>
                            </div>
                        );
                    })}
                </div>
            )}

            {!queueAcceptsMore && (
                <Paragraph className={cl("muted")}>
                    The queue ends with a game that plays until stopped, so nothing can follow it.
                </Paragraph>
            )}

            {error != null && <Notice.Danger>{error}</Notice.Danger>}

            <div className={cl("actions")}>
                <Button
                    variant="secondary"
                    disabled={entry == null || !queueAcceptsMore}
                    onClick={() => {
                        act(() => setQueue([...queue, entry!]));
                        clearSelectedGame();
                    }}
                >
                    Add to queue
                </Button>
                {session != null && queue.length > 0 && (
                    <Button variant="secondary" onClick={() => act(() => advanceQueue(Date.now()))}>
                        Skip
                    </Button>
                )}
                <Button
                    variant="dangerSecondary"
                    disabled={session == null && queue.length === 0}
                    onClick={() => act(stopAll)}
                >
                    Stop
                </Button>
                <Button
                    disabled={!startsQueue && (entry == null || backdate == null)}
                    onClick={() => {
                        if (startsQueue) {
                            act(() => advanceQueue(Date.now()));
                            return;
                        }

                        act(() => startNow(entry!, backdate!));
                        clearSelectedGame();
                    }}
                >
                    {startsQueue ? "Start queue" : session == null ? "Start playing" : "Switch game"}
                </Button>
            </div>
        </div>
    );
}

function SpooferModal({ rootProps }: { rootProps: RenderModalProps; }) {
    return (
        <Modal {...rootProps} size="md" title="Game Session Spoofer">
            <SpooferPanel />
        </Modal>
    );
}

const SafeSpooferModal = ErrorBoundary.wrap(SpooferModal, { noop: true });

function openSpooferModal() {
    openModal(rootProps => <SafeSpooferModal rootProps={rootProps} />);
}

function GameSessionSpooferButton({ iconForeground, hideTooltips, nameplate }: UserAreaRenderProps) {
    return (
        <UserAreaButton
            tooltipText={hideTooltips ? void 0 : "Open Game Session Spoofer"}
            icon={<GameControllerIcon className={iconForeground} />}
            plated={nameplate != null}
            onClick={openSpooferModal}
        />
    );
}

const GameSessionSpooferUserAreaButton: UserAreaButtonFactory = props => <GameSessionSpooferButton {...props} />;

const settings = definePluginSettings({
    creditPlaytime: {
        type: OptionType.BOOLEAN,
        description: "Report finished sessions to Discord's analytics endpoint so they count towards your playtime badge",
        default: false
    },
    streamWindow: {
        type: OptionType.BOOLEAN,
        description: "Give the spoofed game a real window so Go Live can stream it as that game",
        default: false
    },
    session: {
        type: OptionType.CUSTOM,
        description: "Session restored after a restart",
        default: null as StoredSession | null
    },
    queue: {
        type: OptionType.CUSTOM,
        description: "Games lined up behind the current session",
        default: [] as QueuedGame[]
    }
});

export default definePlugin({
    name: "GameSessionSpoofer",
    authors: [EquicordDevs.benjii],
    description: "Appear to be playing any game Discord can detect without launching it, alone or as a timed queue.",
    tags: ["Utility", "Activity"],
    dependencies: ["UserSettingsAPI", "UserAreaAPI"],
    settings,
    userAreaButton: {
        icon: GameControllerIcon,
        render: GameSessionSpooferUserAreaButton
    },
    patches: [{
        find: "FirstPartyRichPresenceStore",
        replacement: {
            match: /name:(\i)\.name,application_id:\1\.id\?\?.{0,20},timestamps:\{start:\i\?\?\1\.start\},/,
            replace: "$&...$self.getGameActivityAssets($1),"
        }
    }],

    getGameActivityAssets(game: RunningGame) {
        const { id } = game;
        const image = id == null ? null : gameImages.get(id);

        return image == null ? {} : {
            assets: {
                large_image: image.activityImage,
                large_text: game.name
            }
        };
    },

    start() {
        const stored = settings.store.session;
        const restored = stored && {
            game: buildGame(stored.game, stored.game.start),
            endsAt: stored.endsAt,
            credit: stored.credit && { ...stored.credit }
        };

        queue = settings.store.queue.map(({ id, name, exeName, minutes }) => ({ id, name, exeName, minutes }));
        creditInterval = setInterval(syncCredit, HEARTBEAT_INTERVAL_MS);
        // Nothing was playing, so anything queued keeps waiting for "Start queue".
        if (restored == null) return;

        onceReady.then(() => {
            if (restored.endsAt !== 0 && restored.endsAt <= Date.now()) advanceQueue(restored.endsAt);
            else applySession(restored);
        });
    },

    stop() {
        clearInterval(creditInterval);
        creditInterval = undefined;
        stopAll();
    }
});
