'use strict';

/* exported init enable disable */

const { GLib, Gio, Meta, Shell } = imports.gi;
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

    BeginResize() {
        if (!current_window || !current_window.maximized_vertically)
            return;

        Main.wm.skipNextEffect(current_window.get_compositor_private());
        // There is a update_window_geometry() call after successful unmaximize.
        // It must set window size to 100%.
        // Changing window-height should also unmaximize, but sometimes it
        // doesn't if window-height is already 1.0, so another unmaximize() is
        // necessary.
        settings.set_double('window-height', 1.0);
        current_window.unmaximize(Meta.MaximizeFlags.VERTICAL);

        const { workarea } = workarea_for_window(current_window);
        if (!workarea)
            return;

        // On Wayland, the window still unmaximizes to a smaller size without this line
        move_resize_window(current_window, workarea);
    }

    Toggle() {
        toggle();
    }

    Activate() {
        activate();
    }

    RunTestAsync(params, invocation) {
        run_tests(...params).then(_ => {
            invocation.return_value(null);
        }).catch(e => {
            if (e instanceof GLib.Error) {
                invocation.return_gerror(e);
            } else {
                let name = e.name;
                if (!name.includes('.')) {
                    // likely to be a normal JS error
                    name = `org.gnome.gjs.JSError.${name}`;
                }
                logError(e, `Exception in method call: ${invocation.get_method_name()}`);
                invocation.return_dbus_error(name, `${e}\n\n${e.stack}`);
            }
        });
    }
}

const DBUS_INTERFACE = new ExtensionDBusInterface();

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
const update_height_setting_on_grab_end_connections = new ConnectionSet();

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
    extension_connections.connect(settings, 'changed::window-height', disable_window_maximize_setting);
    extension_connections.connect(settings, 'changed::window-height', update_window_geometry);
    extension_connections.connect(settings, 'changed::window-skip-taskbar', set_skip_taskbar);
    extension_connections.connect(settings, 'changed::window-maximize', set_window_maximized);
    extension_connections.connect(settings, 'changed::override-window-animation', setup_animation_overrides);
    extension_connections.connect(settings, 'changed::hide-when-focus-lost', setup_hide_when_focus_lost);

    setup_animation_overrides();
    setup_hide_when_focus_lost();

    setup_update_height_setting_on_grab_end();

    DBUS_INTERFACE.dbus.export(Gio.DBus.session, '/org/gnome/Shell/Extensions/ddterm');
}

function disable() {
    DBUS_INTERFACE.dbus.unexport();

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
    update_height_setting_on_grab_end_connections.disconnect();
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

function check_current_window(match = null) {
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
    if (!check_current_window() || actor !== current_window.get_compositor_private())
        return;

    actor.set_pivot_point(0.5, 0.0);
    actor.scale_x = 1.0;  // override default scale-x animation
    actor.scale_y = 0.0;

    actor.ease({
        scale_y: 1.0,
        duration: WindowManager.SHOW_WINDOW_ANIMATION_TIME,
        mode: settings.get_enum('show-animation'),
    });
}

function override_unmap_animation(wm, actor) {
    if (!check_current_window() || actor !== current_window.get_compositor_private())
        return;

    actor.set_pivot_point(0.5, 0.0);

    actor.ease({
        scale_x: 1.0,  // override default scale-x animation
        scale_y: 0.0,
        duration: WindowManager.DESTROY_WINDOW_ANIMATION_TIME,
        mode: settings.get_enum('hide-animation'),
    });
}

function hide_when_focus_lost() {
    if (!check_current_window() || current_window.is_hidden())
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
    current_window_connections.connect(win, 'notify::maximized-vertically', handle_maximized_vertically);

    setup_update_height_setting_on_grab_end();
    setup_hide_when_focus_lost();
    setup_animation_overrides();

    const monitor_index = Main.layoutManager.currentMonitor.index;
    const workarea = Main.layoutManager.getWorkAreaForMonitor(monitor_index);
    const target_rect = target_rect_for_workarea(workarea, monitor_index);

    move_resize_window(win, target_rect);

    // https://github.com/amezin/gnome-shell-extension-ddterm/issues/28
    current_window_connections.connect(win, 'shown', update_window_geometry);
    current_window_connections.connect(win, 'position-changed', update_window_geometry);

    Main.activateWindow(win);

    set_window_above();
    set_window_stick();
    set_skip_taskbar();
    set_window_maximized();
}

function workarea_for_window(win) {
    // Can't use window.monitor here - it's out of sync
    const monitor_index = global.display.get_monitor_index_for_rect(win.get_frame_rect());
    if (monitor_index < 0)
        return { monitor_index, workarea: null };

    return {
        monitor_index,
        workarea: Main.layoutManager.getWorkAreaForMonitor(monitor_index),
    };
}

function target_rect_for_workarea(workarea, monitor_index) {
    const target_rect = workarea.copy();
    target_rect.height *= settings.get_double('window-height');

    const monitor_scale = global.display.get_monitor_scale(monitor_index);
    target_rect.width -= target_rect.width % monitor_scale;
    target_rect.height -= target_rect.height % monitor_scale;

    return target_rect;
}

function handle_maximized_vertically(win) {
    if (!check_current_window(win))
        return;

    if (!win.maximized_vertically) {
        settings.set_boolean('window-maximize', false);
        update_window_geometry();
        return;
    }

    if (!settings.get_boolean('window-maximize'))
        unmaximize_window_if_not_full_height(win);
}

function unmaximize_window_if_not_full_height(win) {
    const { workarea, monitor_index } = workarea_for_window(current_window);
    if (!workarea)
        return;

    const target_rect = target_rect_for_workarea(workarea, monitor_index);

    if (target_rect.height < workarea.height)
        win.unmaximize(Meta.MaximizeFlags.VERTICAL);
}

function move_resize_window(win, target_rect) {
    win.move_resize_frame(false, target_rect.x, target_rect.y, target_rect.width, target_rect.height);
}

function set_window_maximized() {
    if (!current_window)
        return;

    const should_maximize = settings.get_boolean('window-maximize');
    if (current_window.maximized_vertically === should_maximize)
        return;

    if (should_maximize)
        current_window.maximize(Meta.MaximizeFlags.BOTH);
    else
        unmaximize_window_if_not_full_height(current_window);
}

function disable_window_maximize_setting() {
    // maximize state is always off after a height change
    settings.set_boolean('window-maximize', false);
}

function update_window_geometry() {
    if (!current_window)
        return;

    const { workarea, monitor_index } = workarea_for_window(current_window);
    if (!workarea)
        return;

    const target_rect = target_rect_for_workarea(workarea, monitor_index);
    if (target_rect.equal(current_window.get_frame_rect()))
        return;

    const should_maximize = settings.get_boolean('window-maximize');
    if (current_window.maximized_vertically && target_rect.height < workarea.height && !should_maximize) {
        Main.wm.skipNextEffect(current_window.get_compositor_private());
        current_window.unmaximize(Meta.MaximizeFlags.VERTICAL);
    } else {
        move_resize_window(current_window, target_rect);
    }
}

function update_height_setting_on_grab_end(display, p0, p1) {
    // On Mutter <=3.38 p0 is display too. On 40 p0 is the window.
    const win = p0 instanceof Meta.Window ? p0 : p1;

    if (win !== current_window || win.maximized_vertically)
        return;

    const { workarea } = workarea_for_window(win);
    if (!workarea)
        return;

    const current_height = win.get_frame_rect().height / workarea.height;
    settings.set_double('window-height', Math.min(1.0, current_height));
}

function setup_update_height_setting_on_grab_end() {
    update_height_setting_on_grab_end_connections.disconnect();

    if (current_window)
        update_height_setting_on_grab_end_connections.connect(global.display, 'grab-op-end', update_height_setting_on_grab_end);
}

function release_window(win) {
    if (!win || win !== current_window)
        return;

    current_window_connections.disconnect();
    current_window = null;

    update_height_setting_on_grab_end_connections.disconnect();
    hide_when_focus_lost_connections.disconnect();
    animation_overrides_connections.disconnect();
}

function stop_dbus_watch() {
    if (bus_watch_id) {
        Gio.bus_unwatch_name(bus_watch_id);
        bus_watch_id = null;
    }
}

function async_sleep(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

async function hide_window_async_wait() {
    if (!current_window)
        return;

    toggle();

    while (current_window) {
        // eslint-disable-next-line no-await-in-loop
        await async_sleep(100);
    }
}

async function async_wait_current_window() {
    while (!current_window) {
        // eslint-disable-next-line no-await-in-loop
        await async_sleep(100);
    }
}

const JsUnit = imports.jsUnit;

function assert_rect_equals(expected, actual) {
    JsUnit.assertEquals(expected.x, actual.x);
    JsUnit.assertEquals(expected.y, actual.y);
    JsUnit.assertEquals(expected.width, actual.width);
    JsUnit.assertEquals(expected.height, actual.height);
}

function verify_window_geometry(window_height, window_maximize) {
    const monitor_index = Main.layoutManager.currentMonitor.index;
    const workarea = Main.layoutManager.getWorkAreaForMonitor(monitor_index);
    const frame_rect = current_window.get_frame_rect();

    JsUnit.assertEquals(window_maximize, current_window.maximized_vertically);

    if (window_maximize) {
        assert_rect_equals(workarea, frame_rect);
    } else {
        const target_rect = workarea.copy();
        target_rect.height *= window_height;

        const monitor_scale = global.display.get_monitor_scale(monitor_index);
        target_rect.width -= target_rect.width % monitor_scale;
        target_rect.height -= target_rect.height % monitor_scale;

        assert_rect_equals(target_rect, frame_rect);
    }
}

async function test_show(window_height, window_maximize) {
    await hide_window_async_wait();

    settings.set_double('window-height', window_height);
    settings.set_boolean('window-maximize', window_maximize);

    toggle();

    await async_wait_current_window();
    await async_sleep(200);

    verify_window_geometry(window_height, window_maximize || window_height === 1.0);
}

async function test_maximize_unmaximize(window_height, initial_window_maximize) {
    await hide_window_async_wait();

    settings.set_double('window-height', window_height);
    settings.set_boolean('window-maximize', initial_window_maximize);

    toggle();

    await async_wait_current_window();
    await async_sleep(200);

    verify_window_geometry(window_height, initial_window_maximize || window_height === 1.0);

    settings.set_boolean('window-maximize', true);
    await async_sleep(200);
    verify_window_geometry(window_height, true);

    settings.set_boolean('window-maximize', false);
    await async_sleep(200);
    verify_window_geometry(window_height, window_height === 1.0);
}

async function test_begin_resize(window_height, window_maximize) {
    await hide_window_async_wait();

    settings.set_double('window-height', window_height);
    settings.set_boolean('window-maximize', window_maximize);

    toggle();

    await async_wait_current_window();
    await async_sleep(200);

    verify_window_geometry(window_height, window_maximize || window_height === 1.0);

    DBUS_INTERFACE.BeginResize();

    await async_sleep(200);
    verify_window_geometry(window_maximize ? 1.0 : window_height, false);
}

async function test_unmaximize_correct_height(window_height, window_height2) {
    await hide_window_async_wait();

    settings.set_double('window-height', window_height);
    settings.set_boolean('window-maximize', false);

    toggle();

    await async_wait_current_window();
    await async_sleep(200);

    verify_window_geometry(window_height, window_height === 1.0);

    settings.set_double('window-height', window_height2);
    await async_sleep(200);
    verify_window_geometry(window_height2, window_height === 1.0 && window_height2 === 1.0);

    settings.set_boolean('window-maximize', true);
    await async_sleep(200);
    verify_window_geometry(window_height2, true);

    settings.set_boolean('window-maximize', false);
    await async_sleep(200);
    verify_window_geometry(window_height2, window_height2 === 1.0);
}

async function test_unmaximize_on_height_change(window_height, window_height2) {
    await hide_window_async_wait();

    settings.set_double('window-height', window_height);
    settings.set_boolean('window-maximize', true);

    toggle();

    await async_wait_current_window();
    await async_sleep(200);

    verify_window_geometry(window_height, true);

    settings.set_double('window-height', window_height2);
    await async_sleep(200);
    // When window_height2 === window_height, some GLib/GNOME versions do
    // trigger a change notification, and some don't (and then the window
    // doesn't get unmaximized)
    verify_window_geometry(window_height2, window_height2 === 1.0 || (window_height2 === window_height && current_window.maximized_vertically));
}

async function run_tests() {
    const BOOL_VALUES = [true, false];
    const HEIGHT_VALUES = [0.3, 0.5, 0.7, 0.8, 0.9, 1.0];
    const tests = [];

    const add_test = (func, ...args) => tests.push({ func, args });

    for (let window_maximize of BOOL_VALUES) {
        for (let window_height of HEIGHT_VALUES)
            add_test(test_show, window_height, window_maximize);
    }

    for (let window_maximize of BOOL_VALUES) {
        for (let window_height of HEIGHT_VALUES)
            add_test(test_maximize_unmaximize, window_height, window_maximize);
    }

    for (let window_maximize of BOOL_VALUES) {
        for (let window_height of HEIGHT_VALUES)
            add_test(test_begin_resize, window_height, window_maximize);
    }

    for (let window_height of HEIGHT_VALUES) {
        for (let window_height2 of HEIGHT_VALUES)
            add_test(test_unmaximize_correct_height, window_height, window_height2);
    }

    for (let window_height of HEIGHT_VALUES) {
        for (let window_height2 of HEIGHT_VALUES)
            add_test(test_unmaximize_on_height_change, window_height, window_height2);
    }

    for (let test of tests) {
        const name = JsUnit.getFunctionName(test.func);
        try {
            // eslint-disable-next-line no-await-in-loop
            await test.func(...test.args);
        } catch (e) {
            e.message += `\n${name}(${JSON.stringify(test.args)})`;
            throw e;
        }
    }
}
