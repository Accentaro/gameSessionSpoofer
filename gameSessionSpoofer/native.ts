/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChildProcess, spawn } from "child_process";
import { IpcMainInvokeEvent } from "electron";

export interface GameWindow {
    title: string;
    imageUrl?: string;
}

// A real top level window owned by the helper, so Go Live lists it and maps its PID onto the spoofed game
const WINDOW_SCRIPT = String.raw`
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace VcGameSession -Name User32 -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);'
$form = New-Object Windows.Forms.Form
$form.Text = $env:VC_GSS_TITLE
$form.BackColor = [Drawing.Color]::Black
$form.ClientSize = New-Object Drawing.Size 1280, 720
$form.StartPosition = "CenterScreen"
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $image = [Drawing.Image]::FromStream((New-Object IO.MemoryStream (, (New-Object Net.WebClient).DownloadData($env:VC_GSS_IMAGE))))
    $picture = New-Object Windows.Forms.PictureBox
    $picture.Dock = "Fill"
    $picture.SizeMode = "Zoom"
    $picture.Image = $image
    $form.Controls.Add($picture)
    $form.Icon = [Drawing.Icon]::FromHandle((New-Object Drawing.Bitmap $image, 64, 64).GetHicon())
} catch {
    $label = New-Object Windows.Forms.Label
    $label.Dock = "Fill"
    $label.TextAlign = "MiddleCenter"
    $label.ForeColor = [Drawing.Color]::White
    $label.Font = New-Object Drawing.Font "Segoe UI", 32
    $label.Text = $env:VC_GSS_TITLE
    $form.Controls.Add($label)
}
# windowsHide makes Windows swallow the first show, so force it once the handle exists
$form.add_Shown({ [VcGameSession.User32]::ShowWindow($form.Handle, 5) | Out-Null })
$form.add_FormClosing({ param($s, $e) if ($e.CloseReason -eq "UserClosing") { $e.Cancel = $true; $form.WindowState = "Minimized" } })
[Windows.Forms.Application]::Run($form)
`;

let helperProcess: ChildProcess | null = null;

function stopHelperProcess(): void {
    helperProcess?.kill();
    helperProcess = null;
}

function spawnHelper(window: GameWindow | null): ChildProcess {
    if (process.platform !== "win32") return spawn("sleep", ["2147483647"], { stdio: "ignore" });
    if (window == null) return spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/q", "/c", "pause"], { windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });

    return spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(WINDOW_SCRIPT, "utf16le").toString("base64")],
        {
            windowsHide: true,
            stdio: "ignore",
            env: { ...process.env, VC_GSS_TITLE: window.title, VC_GSS_IMAGE: window.imageUrl ?? "" }
        }
    );
}

export function startGameProcess(_: IpcMainInvokeEvent, window: GameWindow | null = null): Promise<number> {
    stopHelperProcess();

    const child = spawnHelper(window);

    helperProcess = child;

    return new Promise((resolve, reject) => {
        let spawned = false;

        child.once("spawn", () => {
            spawned = true;

            if (helperProcess !== child) {
                child.kill();
                reject(new Error("Game session was replaced before its process started"));
                return;
            }

            if (child.pid == null) {
                helperProcess = null;
                child.kill();
                reject(new Error("Game session process has no PID"));
                return;
            }

            resolve(child.pid);
        });
        child.once("error", error => {
            if (helperProcess === child) helperProcess = null;
            reject(error);
        });
        child.once("exit", () => {
            if (helperProcess === child) helperProcess = null;
            if (!spawned) reject(new Error("Game session process exited before starting"));
        });
    });
}

export function stopGameProcess(_: IpcMainInvokeEvent): void {
    stopHelperProcess();
}

process.once("exit", stopHelperProcess);
