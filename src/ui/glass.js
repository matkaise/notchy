import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Lifetime} from '../lifecycle.js';

// Liquid glass. GNOME's background blur reads the framebuffer it paints into,
// so inside any offscreen effect (rounding, shading) it only sees emptiness.
// Instead the glass layer paints what lies behind it itself — clones of the
// window group and the top bar — blurs that (actor mode) and then refracts it
// in a shader: the rim bends the background outward like a lens, with slight
// chromatic fringes, raised saturation, a tint and a soft inner glow. No
// outline: the shape ends in the bent background itself.
const DECLARATIONS = `
uniform sampler2D tex;
uniform vec2 size;
uniform float pad;
uniform vec4 radii;
uniform vec4 tint;
uniform float refraction;
uniform float rim;
uniform float saturation;
float notchy_glass_sdf(vec2 q, vec2 b, vec4 r) {
    float rad = q.x < 0.0 ? (q.y < 0.0 ? r.x : r.w) : (q.y < 0.0 ? r.y : r.z);
    rad = min(rad, min(b.x, b.y));
    vec2 d = abs(q) - b + rad;
    return min(max(d.x, d.y), 0.0) + length(max(d, 0.0)) - rad;
}`;
const CODE = `
vec2 uv = cogl_tex_coord_in[0].xy;
// Clutter enlarges every effect buffer by 3 px (2 px left/top, 1 px right/
// bottom, _clutter_actor_box_enlarge_for_effects); map back to the layer.
vec2 fbo = size + vec2(3.0);
vec2 p = uv * fbo - vec2(2.0);
vec2 half_size = max(size * 0.5 - vec2(pad), vec2(1.0));
vec2 c = p - size * 0.5;
float d = notchy_glass_sdf(c, half_size, radii);
float alpha = 1.0 - smoothstep(-0.8, 0.8, d);
vec2 n = vec2(notchy_glass_sdf(c + vec2(1.0, 0.0), half_size, radii) - notchy_glass_sdf(c - vec2(1.0, 0.0), half_size, radii),
              notchy_glass_sdf(c + vec2(0.0, 1.0), half_size, radii) - notchy_glass_sdf(c - vec2(0.0, 1.0), half_size, radii));
n = n / max(length(n), 0.0001);
float t = clamp(1.0 + d / 28.0, 0.0, 1.0);
// The bend fades out over the last pixels, so the rim shows no hard line.
vec2 bend = n * refraction * t * t * t * (1.0 - smoothstep(-4.0, 0.0, d)) / fbo;
vec3 col = vec3(texture2D(tex, uv + bend * 1.14).r, texture2D(tex, uv + bend).g, texture2D(tex, uv + bend * 0.86).b);
float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
col = mix(vec3(luma), col, saturation);
col = mix(col, tint.rgb, tint.a);
float light = clamp(dot(n, normalize(vec2(-0.45, -1.0))), 0.0, 1.0);
float glow = smoothstep(-16.0, 0.0, d);
col += vec3(rim * glow * (0.03 + 0.05 * light));
cogl_color_out = vec4(col * alpha, alpha);`;

export const LiquidGlassEffect = GObject.registerClass(class NotchyLiquidGlassEffect extends Shell.GLSLEffect {
    _init() {
        super._init();
        this.locations = Object.fromEntries(['size', 'pad', 'radii', 'tint', 'refraction', 'rim', 'saturation'].map(name => [name, this.get_uniform_location(name)]));
    }
    vfunc_build_pipeline() { this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, DECLARATIONS, CODE, true); }
    set(name, values) { this.set_uniform_float(this.locations[name], values.length, values); }
});

export const GLASS = {
    // Tints are non-premultiplied rgb + amount mixed over the blurred backdrop.
    dynamic: {tint: [0.08, 0.06, 0.09, 0.42], refraction: 22, rim: 0.55, saturation: 1.45, blur: 18},
    liquid: {tint: [0.12, 0.09, 0.13, 0.46], refraction: 18, rim: 0.85, saturation: 1.5, blur: 16},
};

export class GlassLayer {
    constructor(pad = 18) {
        this.pad = pad; this.stage = [0, 0]; this.life = new Lifetime(); this.clones = [];
        // Clipped: the clones extend far beyond the layer, and the effects must
        // render exactly the layer's own area for the shader's geometry.
        this.actor = new Clutter.Actor({name: 'notchy-glass', reactive: false, clip_to_allocation: true});
        // What lies behind the island: wallpaper and each window, then the top
        // bar. The window group itself cannot be cloned: Mutter culls its
        // children against the screen, which is empty inside an offscreen buffer.
        this.panel = new Clutter.Clone({source: Main.layoutManager.panelBox});
        // The blur sits on an inner layer: it enlarges its own paint area, and
        // the outer shader must see exactly the layer's size for its geometry.
        this.content = new Clutter.Actor({clip_to_allocation: true});
        this.actor.add_child(this.content); this.content.add_child(this.panel);
        const rebuild = () => this.rebuild();
        for (const signal of ['child-added', 'child-removed']) this.life.connect(global.window_group, signal, rebuild);
        this.life.connect(global.display, 'restacked', rebuild);
        for (const signal of ['minimize', 'unminimize', 'map', 'destroy']) this.life.connect(global.window_manager, signal, rebuild);
        this.rebuild();
        // The shader on the layer refracts the blurred clones of the inner layer.
        this.glass = new LiquidGlassEffect(); this.actor.add_effect_with_name('notchy-liquid-glass', this.glass);
        this.blur = new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, radius: 18, brightness: 1});
        this.content.add_effect_with_name('notchy-glass-blur', this.blur);
        this.style('dynamic', [0, 0, 30, 30]);
    }
    style(name, radii) {
        const glass = GLASS[name] ?? GLASS.dynamic;
        this.glass.set('tint', glass.tint); this.glass.set('refraction', [glass.refraction]); this.glass.set('rim', [glass.rim]);
        this.glass.set('saturation', [glass.saturation]); this.glass.set('radii', radii); this.glass.set('pad', [this.pad]);
        this.blur.radius = glass.blur;
    }
    rebuild() {
        if (this.life.closed) return;
        this.cloneLife?.dispose(); this.cloneLife = new Lifetime();
        for (const [clone] of this.clones) clone.destroy();
        this.clones = [];
        for (const child of global.window_group.get_children()) {
            // Notchy's own native panes (Regal, drop zone, Korb) sit in or next to
            // the island; blurred into the glass they would appear twice.
            if (child.meta_window?.get_gtk_application_id()?.startsWith('org.notchy.')) continue;
            const clone = new Clutter.Clone({source: child, visible: child.visible});
            this.content.insert_child_below(clone, this.panel); this.clones.push([clone, child]);
            this.cloneLife.connect(child, 'notify::visible', () => { clone.visible = child.visible; });
            for (const signal of ['notify::x', 'notify::y']) this.cloneLife.connect(child, signal, () => this.positionClone(clone, child));
            this.positionClone(clone, child);
        }
    }
    positionClone(clone, child) { clone.set_position(Math.round(child.x - this.stage[0]), Math.round(child.y - this.stage[1])); }
    // Shape rectangle in the parent's coordinates; stage position of the parent.
    place(x, y, width, height, [parentX, parentY]) {
        const pad = this.pad, w = Math.max(1, Math.round(width + 2 * pad)), h = Math.max(1, Math.round(height + 2 * pad));
        this.actor.set_position(Math.round(x - pad), Math.round(y - pad)); this.actor.set_size(w, h); this.content.set_size(w, h);
        const stageX = Math.round(parentX + x - pad), stageY = Math.round(parentY + y - pad);
        this.stage = [stageX, stageY];
        for (const [clone, child] of this.clones) this.positionClone(clone, child);
        const [panelX, panelY] = Main.layoutManager.panelBox.get_transformed_position();
        this.panel.set_position(Math.round(panelX) - stageX, Math.round(panelY) - stageY);
        this.glass.set('size', [w, h]);
    }
    destroy() { this.cloneLife?.dispose(); this.life.dispose(); this.actor.destroy(); }
}
