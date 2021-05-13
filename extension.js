'use strict';

/* exported init enable disable */

const { Gio, Clutter, Meta, Shell } = imports.gi;
const ByteArray = imports.byteArray;
const Main = imports.ui.main;
const Me = imports.misc.extensionUtils.getCurrentExtension();
const WindowManager = imports.ui.windowManager;

let settings = null;

let current_window = null;

let bus_watch_id = null;
let dbus_action_group = null;

let wayland_client = null;
let subprocess = null;

let window_pos_x = 0;
let window_pos_y = 0;
let window_animate_start_scale_x = 0;
let window_animate_start_scale_y = 0;
let window_resizable_horizontally = false;
let window_resizable_vertically = false;
let window_maximize_flag = 0;

const APP_ID = 'com.github.amezin.ddterm';
const APP_DBUS_PATH = '/com/github/amezin/ddterm';
const WINDOW_PATH_PREFIX = `${APP_DBUS_PATH}/window/`;
const SUBPROCESS_ARGV = [Me.dir.get_child('com.github.amezin.ddterm').get_path(), '--undecorated'];
const IS_WAYLAND_COMPOSITOR = Meta.is_wayland_compositor();
const USE_WAYLAND_CLIENT = Meta.WaylandClient && IS_WAYLAND_COMPOSITOR;
const SIGINT = 2;

class ExtensionDBusInterface {
    constructor() {
        let [_, xml] = Me.dir.get_child('com.github.amezin.ddterm.Extension.xml').load_contents(null);
        this.dbus = Gio.DBusExportedObject.wrapJSObject(ByteArray.toString(xml), this);
    }

    BeginResizeVertical() {
        if (!current_window || !current_window.maximized_vertically || !window_resizable_vertically)
            return;

        print('BeginResizeVertical');

        const workarea = workarea_for_window(current_window);

        Main.wm.skipNextEffect(current_window.get_compositor_private());
        current_window.unmaximize(Meta.MaximizeFlags.VERTICAL);

        move_resize_window(current_window, workarea);
    }

    BeginResizeHorizontal() {
        if (!current_window || !current_window.maximized_horizontally || !window_resizable_horizontally)
            return;

        print('BeginResizeHorizontal');

        const workarea = workarea_for_window(current_window);

        Main.wm.skipNextEffect(current_window.get_compositor_private());
        current_window.unmaximize(Meta.MaximizeFlags.HORIZONTAL);

        move_resize_window(current_window, workarea);
    }

    Toggle() {
        toggle();
    }

    Activate() {
        activate();
    }
}

const DBUS_INTERFACE = new ExtensionDBusInterface().dbus;

class WaylandClientStub {
    constructor(subprocess_launcher) {
        this.subprocess_launcher = subprocess_launcher;
    }

    spawnv(_display, argv) {
        return this.subprocess_launcher.spawnv(argv);
    }

    hide_from_window_list(_win) {
    }

    show_in_window_list(_win) {
    }

    owns_window(_win) {
        return true;
    }
}

class ConnectionSet {
    constructor() {
        this.connections = [];
    }

    add(object, handler_id) {
        this.connections.push({ object, handler_id });
    }

    connect(object, signal, callback) {
        this.add(object, object.connect(signal, callback));
    }

    disconnect() {
        while (this.connections.length) {
            const c = this.connections.pop();
            try {
                c.object.disconnect(c.handler_id);
            } catch (ex) {
                logError(ex, `Can't disconnect handler ${c.handler_id} on object ${c.object}`);
            }
        }
    }
}

const extension_connections = new ConnectionSet();
const current_window_connections = new ConnectionSet();
const animation_overrides_connections = new ConnectionSet();
const hide_when_focus_lost_connections = new ConnectionSet();
const update_size_setting_on_grab_end_connections = new ConnectionSet();

function init() {
}

function enable() {
    extension_connections.disconnect();
    settings = imports.misc.extensionUtils.getSettings();

    Main.wm.addKeybinding(
        'ddterm-toggle-hotkey',
        settings,
        Meta.KeyBindingFlags.NONE,
        Shell.ActionMode.NORMAL,
        toggle
    );
    Main.wm.addKeybinding(
        'ddterm-activate-hotkey',
        settings,
        Meta.KeyBindingFlags.NONE,
        Shell.ActionMode.NORMAL,
        activate
    );

    stop_dbus_watch();
    bus_watch_id = Gio.bus_watch_name(
        Gio.BusType.SESSION,
        APP_ID,
        Gio.BusNameWatcherFlags.NONE,
        dbus_appeared,
        dbus_disappeared
    );

    extension_connections.connect(global.display, 'window-created', handle_window_created);
    extension_connections.connect(settings, 'changed::window-above', set_window_above);
    extension_connections.connect(settings, 'changed::window-stick', set_window_stick);
    extension_connections.connect(settings, 'changed::window-size', () => settings.set_boolean('window-maximize', false));
    extension_connections.connect(settings, 'changed::window-size', update_window_geometry);
    extension_connections.connect(settings, 'changed::window-position', update_window_pos);
    extension_connections.connect(settings, 'changed::window-position', update_window_geometry);
    extension_connections.connect(settings, 'changed::window-skip-taskbar', set_skip_taskbar);
    extension_connections.connect(settings, 'changed::window-maximize', set_window_maximized);
    extension_connections.connect(settings, 'changed::override-window-animation', setup_animation_overrides);
    extension_connections.connect(settings, 'changed::hide-when-focus-lost', setup_hide_when_focus_lost);

    update_window_pos();

    setup_animation_overrides();
    setup_hide_when_focus_lost();

    setup_update_size_setting_on_grab_end();

    DBUS_INTERFACE.export(Gio.DBus.session, '/org/gnome/Shell/Extensions/ddterm');
}

function disable() {
    DBUS_INTERFACE.unexport();

    if (Main.sessionMode.allowExtensions) {
        // Stop the app only if the extension isn't being disabled because of
        // lock screen/switch to other mode where extensions aren't allowed.
        // Because when the session switches back to normal mode we want to
        // keep all open terminals.
        if (dbus_action_group)
            dbus_action_group.activate_action('quit', null);
        else if (subprocess)
            subprocess.send_signal(SIGINT);
    }

    stop_dbus_watch();
    dbus_action_group = null;

    Main.wm.removeKeybinding('ddterm-toggle-hotkey');
    Main.wm.removeKeybinding('ddterm-activate-hotkey');

    extension_connections.disconnect();
    animation_overrides_connections.disconnect();
    hide_when_focus_lost_connections.disconnect();
    update_size_setting_on_grab_end_connections.disconnect();
}

function spawn_app() {
    if (subprocess)
        return;

    const subprocess_launcher = Gio.SubprocessLauncher.new(Gio.SubprocessFlags.NONE);

    const context = global.create_app_launch_context(0, -1);
    subprocess_launcher.set_environ(context.get_environment());

    let argv = SUBPROCESS_ARGV;

    if (settings.get_boolean('force-x11-gdk-backend')) {
        const prev_gdk_backend = subprocess_launcher.getenv('GDK_BACKEND');

        if (prev_gdk_backend === null)
            argv = argv.concat(['--unset-gdk-backend']);
        else
            argv = argv.concat(['--reset-gdk-backend', prev_gdk_backend]);

        subprocess_launcher.setenv('GDK_BACKEND', 'x11', true);
    }

    if (USE_WAYLAND_CLIENT && subprocess_launcher.getenv('GDK_BACKEND') !== 'x11')
        wayland_client = Meta.WaylandClient.new(subprocess_launcher);
    else
        wayland_client = new WaylandClientStub(subprocess_launcher);

    subprocess = wayland_client.spawnv(global.display, argv);
    subprocess.wait_async(null, subprocess_terminated);
}

function subprocess_terminated(source) {
    if (subprocess === source) {
        subprocess = null;
        wayland_client = null;
    }
}

function toggle() {
    if (dbus_action_group)
        dbus_action_group.activate_action('toggle', null);
    else
        spawn_app();
}

function activate() {
    if (current_window)
        Main.activateWindow(current_window);
    else
        toggle();
}

function dbus_appeared(connection, name) {
    dbus_action_group = Gio.DBusActionGroup.get(connection, name, APP_DBUS_PATH);
}

function dbus_disappeared() {
    dbus_action_group = null;
}

function handle_window_created(display, win) {
    const handler_ids = [
        win.connect('notify::gtk-application-id', set_current_window),
        win.connect('notify::gtk-window-object-path', set_current_window),
    ];

    const disconnect = () => {
        handler_ids.forEach(handler => win.disconnect(handler));
    };

    handler_ids.push(win.connect('unmanaging', disconnect));
    handler_ids.push(win.connect('unmanaged', disconnect));

    set_current_window(win);
}

function assert_current_window(match = null) {
    if (current_window === null) {
        logError(new Error('current_window should be non-null'));
        return false;
    }

    if (match !== null && current_window !== match) {
        logError(new Error(`current_window should be ${match}, but it is ${current_window}`));
        return false;
    }

    return true;
}

function setup_animation_overrides() {
    animation_overrides_connections.disconnect();

    if (current_window && settings.get_boolean('override-window-animation')) {
        animation_overrides_connections.connect(global.window_manager, 'map', override_map_animation);
        animation_overrides_connections.connect(global.window_manager, 'destroy', override_unmap_animation);
    }
}

function override_map_animation(wm, actor) {
    if (!assert_current_window() || actor !== current_window.get_compositor_private())
        return;

    actor.set_pivot_point(window_pos_x, window_pos_y);

    actor.scale_x = window_animate_start_scale_x;
    actor.scale_y = window_animate_start_scale_y;

    actor.ease({
        scale_x: 1.0,
        scale_y: 1.0,
        duration: WindowManager.SHOW_WINDOW_ANIMATION_TIME,
        mode: Clutter.AnimationMode.LINEAR,
    });
}

function override_unmap_animation(wm, actor) {
    if (!assert_current_window() || actor !== current_window.get_compositor_private())
        return;

    actor.set_pivot_point(window_pos_x, window_pos_y);

    actor.ease({
        scale_x: window_animate_start_scale_x,
        scale_y: window_animate_start_scale_y,
        duration: WindowManager.DESTROY_WINDOW_ANIMATION_TIME,
        mode: Clutter.AnimationMode.LINEAR,
    });
}

function hide_when_focus_lost() {
    if (!assert_current_window() || current_window.is_hidden())
        return;

    const win = global.display.focus_window;
    if (win !== null) {
        if (current_window === win || current_window.is_ancestor_of_transient(win))
            return;
    }

    if (dbus_action_group)
        dbus_action_group.activate_action('hide', null);
}

function setup_hide_when_focus_lost() {
    hide_when_focus_lost_connections.disconnect();

    if (current_window && settings.get_boolean('hide-when-focus-lost'))
        hide_when_focus_lost_connections.connect(global.display, 'notify::focus-window', hide_when_focus_lost);
}

function is_ddterm_window(win) {
    if (!wayland_client) {
        // On X11, shell can be restarted, and the app will keep running.
        // Accept windows from previously launched app instances.
        if (IS_WAYLAND_COMPOSITOR)
            return false;
    } else if (!wayland_client.owns_window(win)) {
        return false;
    }

    return (
        win.gtk_application_id === APP_ID &&
        win.gtk_window_object_path &&
        win.gtk_window_object_path.startsWith(WINDOW_PATH_PREFIX)
    );
}

function set_window_above() {
    if (current_window === null)
        return;

    if (settings.get_boolean('window-above'))
        current_window.make_above();
    else
        current_window.unmake_above();
}

function set_window_stick() {
    if (current_window === null)
        return;

    if (settings.get_boolean('window-stick'))
        current_window.stick();
    else
        current_window.unstick();
}

function set_skip_taskbar() {
    if (!current_window || !wayland_client)
        return;

    if (settings.get_boolean('window-skip-taskbar'))
        wayland_client.hide_from_window_list(current_window);
    else
        wayland_client.show_in_window_list(current_window);
}

function set_current_window(win) {
    if (!is_ddterm_window(win)) {
        release_window(win);
        return;
    }

    if (win === current_window)
        return;

    release_window(current_window);
    current_window = win;

    current_window_connections.connect(win, 'unmanaged', release_window);

    current_window_connections.connect(win, 'notify::maximized-vertically', unmaximize_window_vertically);
    current_window_connections.connect(win, 'notify::maximized-horizontally', unmaximize_window_horizontally);

    setup_update_size_setting_on_grab_end();
    setup_hide_when_focus_lost();
    setup_animation_overrides();

    const workarea = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.currentMonitor.index);
    const target_rect = target_rect_for_workarea(workarea);

    move_resize_window(win, target_rect);

    // https://github.com/amezin/gnome-shell-extension-ddterm/issues/28
    current_window_connections.connect(win, 'shown', update_window_geometry);

    Main.activateWindow(win);

    set_window_above();
    set_window_stick();
    set_skip_taskbar();
    set_window_maximized();
}

function workarea_for_window(win) {
    // Can't use window.monitor here - it's out of sync
    const monitor = global.display.get_monitor_index_for_rect(win.get_frame_rect());
    if (monitor < 0)
        return null;

    return Main.layoutManager.getWorkAreaForMonitor(monitor);
}

function update_window_pos() {
    const pos = settings.get_string('window-position');

    window_pos_x = 0.0;
    window_pos_y = 0.0;
    window_animate_start_scale_x = 0.0;
    window_animate_start_scale_y = 0.0;
    window_resizable_horizontally = false;
    window_resizable_vertically = false;
    window_maximize_flag = 0;

    switch (pos) {
    case 'bottom':
        window_pos_y = 1.0;
        // falls through
    case 'top':
        window_resizable_vertically = true;
        window_animate_start_scale_x = 1.0;
        window_maximize_flag = Meta.MaximizeFlags.VERTICAL;
        break;
    case 'right':
        window_pos_x = 1.0;
        // falls through
    case 'left':
        window_resizable_horizontally = true;
        window_animate_start_scale_y = 1.0;
        window_maximize_flag = Meta.MaximizeFlags.HORIZONTAL;
        break;
    default:
        logError(new Error(`Invalid window-position: ${pos}`));
    }
}

function target_rect_for_workarea(workarea) {
    const target_rect = workarea.copy();
    const size = settings.get_double('window-size');

    if (window_resizable_horizontally)
        target_rect.width *= size;

    if (window_resizable_vertically)
        target_rect.height *= size;

    target_rect.x += (workarea.width - target_rect.width) * window_pos_x;
    target_rect.y += (workarea.height - target_rect.height) * window_pos_y;

    return target_rect;
}

function unmaximize_window_done(win, flags) {
    print(`unmaximize done ${flags}`);

    if (flags & window_maximize_flag)
        settings.set_boolean('window-maximize', false);

    update_window_geometry();
}

function unmaximize_window_vertically(win) {
    if (!assert_current_window(win))
        return;

    if (!win.maximized_vertically) {
        unmaximize_window_done(win, Meta.MaximizeFlags.VERTICAL);
        return;
    }

    if (settings.get_boolean('window-maximize'))
        return;

    const workarea = workarea_for_window(current_window);
    const target_rect = target_rect_for_workarea(workarea);

    if (target_rect.height < workarea.height) {
        print('unmaximize_window_vertically');
        win.unmaximize(Meta.MaximizeFlags.VERTICAL);
    }
}

function unmaximize_window_horizontally(win) {
    if (!assert_current_window(win))
        return;

    if (!win.maximized_horizontally) {
        unmaximize_window_done(win, Meta.MaximizeFlags.HORIZONTAL);
        return;
    }

    if (settings.get_boolean('window-maximize'))
        return;

    const workarea = workarea_for_window(current_window);
    const target_rect = target_rect_for_workarea(workarea);

    if (target_rect.width < workarea.width) {
        printerr('unmaximize_window_horizontally');
        win.unmaximize(Meta.MaximizeFlags.HORIZONTAL);
    }
}

function move_resize_window(win, target_rect) {
    printerr(`Moving to x=${target_rect.x} y=${target_rect.y} width=${target_rect.width} height=${target_rect.height}`);
    win.move_resize_frame(false, target_rect.x, target_rect.y, target_rect.width, target_rect.height);
}

function get_maximize_flags(win) {
    return (win.maximized_horizontally ? Meta.MaximizeFlags.HORIZONTAL : 0) |
        (win.maximized_vertically ? Meta.MaximizeFlags.VERTICAL : 0);
}

function set_window_maximized() {
    if (!current_window)
        return;

    const should_maximize = settings.get_boolean('window-maximize');
    if (should_maximize === !!(get_maximize_flags(current_window) & window_maximize_flag))
        return;

    if (should_maximize) {
        printerr('set_window_maximized: maximizing');
        current_window.maximize(Meta.MaximizeFlags.BOTH);
    } else {
        const workarea = workarea_for_window(current_window);
        const target_rect = target_rect_for_workarea(workarea);

        if ((window_maximize_flag & Meta.MaximizeFlags.VERTICAL) && target_rect.height < workarea.height) {
            printerr('set_window_maximized: unmaximize');
            current_window.unmaximize(Meta.MaximizeFlags.VERTICAL);
        }

        if ((window_maximize_flag & Meta.MaximizeFlags.HORIZONTAL) && target_rect.width < workarea.width) {
            printerr('set_window_maximized: unmaximize');
            current_window.unmaximize(Meta.MaximizeFlags.HORIZONTAL);
        }
    }
}

function update_window_geometry() {
    if (!current_window)
        return;

    printerr('update_window_geometry');

    const workarea = workarea_for_window(current_window);
    if (!workarea)
        return;

    const target_rect = target_rect_for_workarea(workarea);
    if (target_rect.equal(current_window.get_frame_rect()))
        return;

    const should_maximize = settings.get_boolean('window-maximize');
    if (current_window.maximized_vertically && target_rect.height < workarea.height && !should_maximize) {
        printerr('update_window_geometry unmaximize vertical');
        Main.wm.skipNextEffect(current_window.get_compositor_private());
        current_window.unmaximize(Meta.MaximizeFlags.VERTICAL);
    } else if (current_window.maximized_horizontally && target_rect.width < workarea.width && !should_maximize) {
        printerr('update_window_geometry unmaximize horizontal');
        Main.wm.skipNextEffect(current_window.get_compositor_private());
        current_window.unmaximize(Meta.MaximizeFlags.HORIZONTAL);
    } else {
        move_resize_window(current_window, target_rect);
    }
}

function update_size_setting_on_grab_end(display, p0, p1) {
    // On Mutter <=3.38 p0 is display too. On 40 p0 is the window.
    const win = p0 instanceof Meta.Window ? p0 : p1;

    if (win !== current_window)
        return;

    if (window_resizable_vertically && win.maximized_vertically)
        return;

    if (window_resizable_horizontally && win.maximized_horizontally)
        return;

    const workarea = workarea_for_window(win);
    const current_size = window_resizable_vertically ? win.get_frame_rect().height / workarea.height : win.get_frame_rect().width / workarea.width;
    settings.set_double('window-size', Math.min(1.0, current_size));
}

function setup_update_size_setting_on_grab_end() {
    update_size_setting_on_grab_end_connections.disconnect();

    if (current_window)
        update_size_setting_on_grab_end_connections.connect(global.display, 'grab-op-end', update_size_setting_on_grab_end);
}

function release_window(win) {
    if (!win || win !== current_window)
        return;

    current_window_connections.disconnect();
    current_window = null;

    update_size_setting_on_grab_end_connections.disconnect();
    hide_when_focus_lost_connections.disconnect();
    animation_overrides_connections.disconnect();
}

function stop_dbus_watch() {
    if (bus_watch_id) {
        Gio.bus_unwatch_name(bus_watch_id);
        bus_watch_id = null;
    }
}
