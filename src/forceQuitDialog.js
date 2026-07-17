/*
 * SPDX-License-Identifier: GPL-3.0-or-later
 * forceQuitDialog.js - macOS style "Force Quit Applications" dialog listing
 * running applications with their CPU and memory usage.
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async');

const REFRESH_INTERVAL_MS = 2000;

const NON_KILLABLE_WM_CLASSES = new Set([
  'gnome-shell',
  'nautilus',
  'org.gnome.nautilus',
]);

const NON_KILLABLE_APP_IDS = new Set([
  'org.gnome.Nautilus.desktop',
]);

let activeDialog = null;

async function readProcFile(path) {
  try {
    const file = Gio.File.new_for_path(path);
    const [contents] = await file.load_contents_async(null);
    return new TextDecoder().decode(contents);
  } catch {
    // Process exited or /proc entry is unreadable.
    return null;
  }
}

async function readTotalCpuTicks() {
  const contents = await readProcFile('/proc/stat');
  const line = contents?.split('\n', 1)[0] ?? '';
  if (!line.startsWith('cpu')) {
    return 0;
  }

  return line
    .trim()
    .split(/\s+/)
    .slice(1, 9)
    .reduce((sum, field) => sum + (Number.parseInt(field, 10) || 0), 0);
}

async function readProcessCpuTicks(pid) {
  const contents = await readProcFile(`/proc/${pid}/stat`);
  const closeParen = contents?.lastIndexOf(')') ?? -1;
  if (closeParen < 0) {
    return 0;
  }

  // Fields after the parenthesised command name: state(0) ... utime(11) stime(12)
  const fields = contents.slice(closeParen + 1).trim().split(/\s+/);
  const utime = Number.parseInt(fields[11], 10) || 0;
  const stime = Number.parseInt(fields[12], 10) || 0;
  return utime + stime;
}

async function readProcessRssKb(pid) {
  const contents = await readProcFile(`/proc/${pid}/status`);
  const match = contents?.match(/^VmRSS:\s+(\d+)\s+kB/m);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function getAppPids(app) {
  const pids = new Set();
  for (const window of app.get_windows()) {
    const pid = window.get_pid?.() ?? 0;
    if (pid > 0) {
      pids.add(pid);
    }
  }
  return [...pids];
}

function isKillableApp(app) {
  if (NON_KILLABLE_APP_IDS.has(app.get_id())) {
    return false;
  }

  const windows = app.get_windows();
  if (windows.length === 0) {
    return false;
  }

  return !windows.some((window) => {
    const wmClass = window.get_wm_class()?.toLowerCase?.() ?? '';
    return NON_KILLABLE_WM_CLASSES.has(wmClass);
  });
}

function getRunningApps() {
  return Shell.AppSystem.get_default()
    .get_running()
    .filter(isKillableApp)
    .sort((a, b) => GLib.utf8_collate(a.get_name() ?? '', b.get_name() ?? ''));
}

function formatMemory(rssKb) {
  const mb = rssKb / 1024;
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(1)} GB`;
  }
  return `${Math.round(mb)} MB`;
}

const ForceQuitDialog = GObject.registerClass(
  { GTypeName: 'KiwiForceQuitDialog' },
  class ForceQuitDialog extends ModalDialog.ModalDialog {
    _init(gettext) {
      super._init({ styleClass: 'kiwi-force-quit-dialog' });

      this._gettext = gettext;
      this._rows = new Map();
      this._rowAppIds = '';
      this._selectedApp = null;
      this._previousTicks = new Map();
      this._previousTotalTicks = 0;
      this._isRefreshing = false;
      this._isDestroyed = false;

      this._buildContent();

      this.addButton({
        label: this._gettext('Cancel'),
        action: () => this.close(),
        key: Clutter.KEY_Escape,
      });
      this._forceQuitButton = this.addButton({
        label: this._gettext('Force Quit'),
        action: () => this._forceQuitSelected(),
        default: true,
      });
      this._setForceQuitEnabled(false);

      this._refreshTimeoutId = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        REFRESH_INTERVAL_MS,
        () => {
          this._refresh().catch(logError);
          return GLib.SOURCE_CONTINUE;
        }
      );

      this.connect('destroy', () => {
        this._isDestroyed = true;
        if (this._refreshTimeoutId) {
          GLib.source_remove(this._refreshTimeoutId);
          this._refreshTimeoutId = 0;
        }
      });

      this._refresh().catch(logError);
    }

    _buildContent() {
      const title = new St.Label({
        text: this._gettext('Force Quit Applications'),
        style_class: 'kiwi-force-quit-title',
        x_align: Clutter.ActorAlign.CENTER,
      });

      const description = new St.Label({
        text: this._gettext(
          "If an app doesn't respond for a while, select its name and click Force Quit."
        ),
        style_class: 'kiwi-force-quit-description',
      });
      description.clutter_text.line_wrap = true;

      const header = new St.BoxLayout({ style_class: 'kiwi-force-quit-header' });
      header.add_child(new St.Label({ text: this._gettext('Application'), x_expand: true }));
      header.add_child(new St.Label({ text: this._gettext('CPU'), style_class: 'kiwi-force-quit-cpu' }));
      header.add_child(new St.Label({ text: this._gettext('Memory'), style_class: 'kiwi-force-quit-memory' }));

      this._list = new St.BoxLayout({
        vertical: true,
        style_class: 'kiwi-force-quit-list',
        x_expand: true,
      });

      const scroll = new St.ScrollView({
        style_class: 'kiwi-force-quit-scroll',
        hscrollbar_policy: St.PolicyType.NEVER,
        vscrollbar_policy: St.PolicyType.AUTOMATIC,
      });
      if (typeof scroll.set_child === 'function') {
        scroll.set_child(this._list);
      } else {
        scroll.add_actor(this._list);
      }

      this.contentLayout.add_child(title);
      this.contentLayout.add_child(description);
      this.contentLayout.add_child(header);
      this.contentLayout.add_child(scroll);
    }

    _createRow(app) {
      const content = new St.BoxLayout({ x_expand: true });

      const icon = app.create_icon_texture(24);
      if (icon) {
        content.add_child(icon);
      }

      const nameLabel = new St.Label({
        text: app.get_name() ?? '',
        style_class: 'kiwi-force-quit-name',
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
      });
      const cpuLabel = new St.Label({
        text: '—',
        style_class: 'kiwi-force-quit-cpu',
        y_align: Clutter.ActorAlign.CENTER,
      });
      const memoryLabel = new St.Label({
        text: '—',
        style_class: 'kiwi-force-quit-memory',
        y_align: Clutter.ActorAlign.CENTER,
      });

      content.add_child(nameLabel);
      content.add_child(cpuLabel);
      content.add_child(memoryLabel);

      const row = new St.Button({
        style_class: 'kiwi-force-quit-item',
        can_focus: true,
        x_expand: true,
        child: content,
      });
      row.connect('clicked', () => this._selectApp(app));

      row._cpuLabel = cpuLabel;
      row._memoryLabel = memoryLabel;
      return row;
    }

    _rebuildRows(apps) {
      this._list.destroy_all_children();
      this._rows.clear();

      const selectedId = this._selectedApp?.get_id();
      let selectedStillRunning = false;

      for (const app of apps) {
        const row = this._createRow(app);
        if (app.get_id() === selectedId) {
          row.add_style_pseudo_class('selected');
          this._selectedApp = app;
          selectedStillRunning = true;
        }
        this._list.add_child(row);
        this._rows.set(app.get_id(), row);
      }

      if (!selectedStillRunning) {
        this._selectedApp = null;
        this._setForceQuitEnabled(false);
      }
    }

    _selectApp(app) {
      this._selectedApp = app;

      for (const [appId, row] of this._rows) {
        if (appId === app.get_id()) {
          row.add_style_pseudo_class('selected');
        } else {
          row.remove_style_pseudo_class('selected');
        }
      }

      this._setForceQuitEnabled(true);
    }

    _setForceQuitEnabled(enabled) {
      this._forceQuitButton.reactive = enabled;
      this._forceQuitButton.can_focus = enabled;
      if (enabled) {
        this._forceQuitButton.remove_style_pseudo_class('insensitive');
      } else {
        this._forceQuitButton.add_style_pseudo_class('insensitive');
      }
    }

    _forceQuitSelected() {
      const app = this._selectedApp;
      if (!app) {
        return;
      }

      const killedPids = new Set();
      for (const window of app.get_windows()) {
        const pid = window.get_pid?.() ?? 0;
        if (killedPids.has(pid)) {
          continue;
        }
        killedPids.add(pid);

        try {
          window.kill();
        } catch (error) {
          logError(error, `Failed to force quit ${app.get_name()}`);
        }
      }

      this.close();
    }

    async _refresh() {
      if (this._isRefreshing || this._isDestroyed) {
        return;
      }
      this._isRefreshing = true;

      try {
        const apps = getRunningApps();

        const appIds = apps.map((app) => app.get_id()).join('\n');
        if (appIds !== this._rowAppIds) {
          this._rebuildRows(apps);
          this._rowAppIds = appIds;
        }

        const totalTicks = await readTotalCpuTicks();
        const stats = await Promise.all(
          apps.map(async (app) => {
            const pids = getAppPids(app);
            const ticksList = await Promise.all(pids.map(readProcessCpuTicks));
            const rssList = await Promise.all(pids.map(readProcessRssKb));
            return {
              appId: app.get_id(),
              ticks: ticksList.reduce((a, b) => a + b, 0),
              rssKb: rssList.reduce((a, b) => a + b, 0),
            };
          })
        );

        if (this._isDestroyed) {
          return;
        }

        const totalDelta = totalTicks - this._previousTotalTicks;
        const cpuCount = GLib.get_num_processors();
        const nextTicks = new Map();

        for (const { appId, ticks, rssKb } of stats) {
          nextTicks.set(appId, ticks);

          const row = this._rows.get(appId);
          if (!row) {
            continue;
          }

          const previous = this._previousTicks.get(appId);
          if (previous !== undefined && totalDelta > 0) {
            const cpuPercent = ((ticks - previous) / totalDelta) * cpuCount * 100;
            row._cpuLabel.text = `${Math.max(0, cpuPercent).toFixed(1)}%`;
          }
          row._memoryLabel.text = formatMemory(rssKb);
        }

        this._previousTicks = nextTicks;
        this._previousTotalTicks = totalTicks;
      } finally {
        this._isRefreshing = false;
      }
    }
  }
);

export function openForceQuitDialog(gettext) {
  if (activeDialog) {
    return;
  }

  const dialog = new ForceQuitDialog(gettext ?? ((text) => text));
  activeDialog = dialog;

  dialog.connect('closed', () => {
    if (activeDialog === dialog) {
      activeDialog = null;
    }
    dialog.destroy();
  });

  if (!dialog.open()) {
    activeDialog = null;
    dialog.destroy();
  }
}
