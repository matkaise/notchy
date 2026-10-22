import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';
import {hasProperty} from './detect.js';

// Clutter's backend. clutter_get_default_backend() is gone in GNOME 51; the
// stage's context has offered the backend since GNOME 46.
export function backend() {
    const context = global.stage?.get_context?.();
    if (context?.get_backend) return context.get_backend();
    return Clutter.get_default_backend();
}

export function keymap() { return backend().get_default_seat().get_keymap(); }

// St.BoxLayout's orientation: the 'orientation' property since GNOME 48
// (the only one in 51); GNOME 47 knows just the boolean 'vertical'.
const ORIENTATION = hasProperty(St.BoxLayout, 'orientation');
export function boxOrientation(vertical) {
    if (ORIENTATION) return {orientation: vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL};
    return {vertical};
}

// Key presses on a text field, before the field acts on them. Up to GNOME 50
// Clutter.Text handled keys in its class handler, after 'key-press-event'.
// GNOME 51 gives every actor with key bindings a Clutter.KeyController that
// handles Return (activate), the arrows, Home/End, Delete and BackSpace before
// the actor's own 'key-press-event' runs. Where an actor has such a
// controller, the handler listens in the capture phase instead, which comes
// before every controller; elsewhere nothing changes.
export function connectKeyPress(actor, handler) {
    const controlled = Clutter.KeyController && actor.get_actions().some(action => action instanceof Clutter.KeyController);
    if (!controlled) return actor.connect('key-press-event', handler);
    return actor.connect('captured-event', (source, event) => event.type() === Clutter.EventType.KEY_PRESS ? handler(source, event) : Clutter.EVENT_PROPAGATE);
}

// GLSL fragment effects. GNOME 47–50 offer Shell.GLSLEffect (47 with its own
// SnippetHook enum, 48–50 with Cogl's; the values are the same); GNOME 51
// removed it for Clutter.ShaderEffect built from a Cogl.Snippet. Both paint
// the actor into an offscreen buffer and run the snippet over its texture
// (layer 0, the sampler 'tex' declared by the caller), so one GLSL source and
// one uniform interface serve both:
//   const Effect = shaderEffect('NotchyFoo', DECLARATIONS, CODE, ['size']);
//   effect.setUniform('size', [w, h]);
const FRAGMENT = Shell.SnippetHook?.FRAGMENT ?? Cogl.SnippetHook?.FRAGMENT ?? 2048;
export const shaderBackend = Shell.GLSLEffect ? 'Shell.GLSLEffect' : 'Clutter.ShaderEffect';

export function shaderEffect(name, declarations, code, uniforms) {
    if (Shell.GLSLEffect) {
        return GObject.registerClass({GTypeName: name}, class extends Shell.GLSLEffect {
            _init(params) {
                super._init(params);
                this.locations = new Map(uniforms.map(uniform => [uniform, this.get_uniform_location(uniform)]));
            }
            vfunc_build_pipeline() { this.add_glsl_snippet(FRAGMENT, declarations, code, true); }
            setUniform(uniform, values) { this.set_uniform_float(this.locations.get(uniform), values.length, values); }
        });
    }
    return GObject.registerClass({GTypeName: name}, class extends Clutter.ShaderEffect {
        vfunc_get_static_snippet() {
            const snippet = Cogl.Snippet.new(FRAGMENT, declarations, null);
            snippet.set_replace(code); return snippet;
        }
        setUniform(uniform, values) { this.set_uniform_float(uniform, values.length, values); }
    });
}
