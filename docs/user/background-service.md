# Running ZeroCode in the background

On Linux, macOS, and Windows, ZeroCode can run as a service for your user so you
do not need to keep a terminal open.

## Manage the service

Install the `zerocode` CLI first ([Install ZeroCode](./install.md#command-line)), then
run these commands on the machine that will host ZeroCode:

| Task                                  | Command                      |
| ------------------------------------- | ---------------------------- |
| Set up access from your other devices | `zerocode up`                |
| See how your other devices reach it   | `zerocode status`            |
| Install and start                     | `zerocode service install`   |
| Inspect status and log location       | `zerocode service status`    |
| Move to a newer release               | `zerocode update`            |
| Restart                               | `zerocode service restart`   |
| Stop and remove from startup          | `zerocode service uninstall` |

The service never writes a pairing code to its log. To connect a device, run
`zerocode pair` on the host, or `zerocode up` to set up access from your other devices.

Uninstalling the service leaves your projects, threads, and settings intact.
Running `zerocode service install` again repairs a service that `zerocode service status`
reports as broken.

`zerocode update` downloads the newest release on your channel and switches `zerocode`
and the service to it. Restarting interrupts running agent turns, terminals,
and remote clients, so it asks first; answer no and the service keeps running
the old version until you run `zerocode service restart`. Pass `--yes` from a
script. A server you started by hand is left running; stop and start it again
to pick up the new version. Wait for any remote update already in progress
before updating; to match a remote client's version, follow
[Updating ZeroCode](./updating.md).

Pass an exact version (`zerocode update 0.0.42`) to pin one, `--channel nightly` to
switch trains, or `--allow-downgrade` to move backwards. `preview` is a
maintainers' test train: its builds can be broken and are never offered as
updates, so the installer and `zerocode update` ask for confirmation before
installing one.

`zerocode uninstall` removes the background service, the `zerocode` launcher, and the
downloaded versions after showing you the list and asking once. Your projects,
threads, and settings under `~/.zerocode/userdata` are kept, along with `service.env`
under ZeroCode home. Pass `--yes` from a script.

## Local network access

A new service answers only on this machine. Other devices reach it through
ZeroCode Connect, or directly once you choose the local network in `zerocode up` (or run
`zerocode up --lan`, which sets `ZEROCODE_LAN=true` in `service.env`). It then listens on
your local network and Tailscale addresses, so the desktop and mobile apps on
the same network connect directly instead of through ZeroCode Connect. It still does
not answer on public addresses. Anyone on the same network can reach the port,
so a pairing code is all that keeps them out. An HTTPS-hosted web app
stays on ZeroCode Connect, because browsers block plain HTTP from an HTTPS page.

A service installed before `ZEROCODE_LAN` existed keeps listening on the local
network. `zerocode status` says so, and `zerocode up --no-lan` turns it off. Any
`ZEROCODE_HOST` value replaces this setting.

## Configure the service environment

Put custom environment variables in `service.env` under the service's ZeroCode home
directory, normally `~/.zerocode/service.env`. This file survives service installation
and updates. For example:

```dotenv
ZEROCODE_PORT=3773
ZEROCODE_HOST=127.0.0.1
```

Use `KEY=VALUE` entries, quoting values that contain spaces or `#`. Values are
literal: shell commands and variable expansion are not evaluated. Entries
override the inherited service environment, except for `PATH`, `ZEROCODE_HOME`,
`ZEROCODE_BOOT_SERVICE_UNIT`, and `ZEROCODE_SERVICE_LAUNCHER_CONTEXT` (including case variants).

Run `zerocode service restart` after changing the file. Changes apply when the service
starts again; switching the server version alone keeps the current values.
For a service installed before env-file support, run `zerocode service install` once
with an up-to-date CLI.
A missing file is ignored; other read failures stop service startup.
If the file contains credentials, restrict access to that file with `chmod 600`
(for the default ZeroCode home, `chmod 600 ~/.zerocode/service.env`).

## Platform support

Linux needs systemd user services. Setup enables lingering so ZeroCode starts at
boot and keeps running after logout. If this needs administrator permission,
setup prints a recovery command before changing the service.

macOS starts the service when you log in and stops it when you log out. Keep the
Mac logged in and awake for unattended remote access. Installing over SSH while
nobody is logged in at the Mac's screen can fail at the final start step; the
service is still installed and will start at the next login.

Windows starts the service when you log in and stops it when you sign out. It
runs without a window as the `zerocode-<domain>-<user name>` task in Task Scheduler, and Task
Scheduler starts it again within a minute if it exits. Lock the screen instead
of signing out, and keep the PC awake, for unattended remote access. Installing
over SSH while nobody is signed in at the PC can fail at the final start step;
the service is still installed and will start at the next sign-in.

`zerocode up` installs the service when you set up ZeroCode Connect, but the two are managed
separately. Signing out of ZeroCode Connect does not stop or uninstall the service.

## Keep the server responsive when agents use all memory

On Linux, agents already run with lower priority than the server. When they
fill the machine's memory, though, the kernel may still slow down or stop the
server, because only an administrator can reserve memory for it. Run, as your
normal user:

```sh
zerocode service protect
```

It shows the system settings it will change, asks before applying them, and
then asks for your sudo password. If the machine runs Tailscale or SSH, it
also offers to protect them, so you can still reach the machine. Memory
protection takes effect at once. The server's protection from the kernel's
out-of-memory killer takes effect after `zerocode service restart`. `zerocode service status` reports whether
the protection is in place, and `zerocode service protect --undo` removes it.

## Troubleshooting

Start with `zerocode service status` on the host. It prints the log path and, on Linux,
checks whether the installed service is running, enabled, and allowed to survive
logout.

If it stops when your SSH session closes, check for `linger-disabled`. An
administrator can enable lingering with:

```sh
sudo loginctl enable-linger "$(id -un)"
```

Over SSH, allow sudo to prompt:

```sh
ssh -t your-server 'sudo loginctl enable-linger "$(id -un)"'
```

Then retry service setup as your normal user. Run only the `loginctl` command
with sudo; running ZeroCode as root creates a separate installation and Connect
identity. Without administrator access, run `zerocode serve` in a terminal and keep
that session open.

| Status problem                          | Next step                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `linger-unavailable`                    | Run `loginctl show-user "$(id -un)" --property=Linger` and check that systemd-logind is available.                             |
| `user-manager-unavailable`              | Run `systemctl --user status` in a login session for the service user; check your distribution's systemd user-session support. |
| `service-disabled` or `service-stopped` | Read the log and, on Linux, `systemctl --user status zerocode.service`, then use the repair command printed by ZeroCode.       |
| `restart-pending`                       | A newer version is installed but the service still runs the previous one. Run `zerocode service restart`.                      |

On macOS, check **System Settings → General → Login Items** if the service no
longer starts at login. If agent work cannot access Desktop, Documents, or
Downloads, it may need Full Disk Access for the `zerocode` executable listed in
`ProgramArguments` in
`~/Library/LaunchAgents/com.zerocode.app.service.plist`.

For failures after signing in to ZeroCode Connect, see
[connection troubleshooting](./zerocode-connect-troubleshooting.md).

## Reclaim database space

ZeroCode removes internal history older than a day on its own while it runs;
your conversations are kept. Databases created before this shrank automatically
still hold the freed space on disk until a one-time offline repair returns it
and turns on automatic shrinking. Settings > Maintenance (web and desktop) or
Settings > Maintenance (mobile) suggests the repair when at least 1 GiB can be
reclaimed.

When the desktop app or the background service runs ZeroCode on that machine,
select **Reclaim** in Settings on web or desktop. ZeroCode checks for free disk
space, then stops, repairs the database, and starts again. It is offline while
the repair runs, and running agents stop. If the repair fails, Settings shows
why.

In other cases, such as a server you started by hand, run `zerocode doctor` on the
machine that hosts the environment. It reports the database size and the
space it can reclaim, then asks which repairs to run;
pass `--fix` to run the recommended ones without a prompt (for scripts), or
`--dry-run` to only report. An installed background service for the same data
directory is stopped for the repair and started again afterwards, also when
the repair fails. Quit a server you started by hand, or the desktop app, first:
the repair refuses to touch a database that is in use, and names the server
process that holds it when it can tell. While the repair runs, a server started
for the same data directory, for example by a desktop app connecting over SSH,
is refused until the repair ends. Use `--base-dir` for a different data
directory.

The repair's time grows with the size of the whole database, not only the
space it reclaims, and can exceed an hour on a large database or a slow disk;
`zerocode doctor` shows each step as it runs. It rebuilds the database through a
temporary copy, so it needs free space of about twice the data still in use
(the database size minus the reclaimable space): once in the system temporary
directory (on Linux and macOS, `TMPDIR`, or `/var/tmp` when it is not set) and
once next to the database for its write-ahead log.

If you upgraded from a version before 0.1.0, its database (`state.sqlite`) is
still kept next to the current one so you can roll back. `zerocode doctor` offers to
delete it, but never selects that repair for you and `--fix` skips it: once it
is gone, a version before 0.1.0 starts with no threads or settings. It does
not offer to delete it while any project or thread you have not deleted is
missing from the current database, so the old file stays available for
recovery.
