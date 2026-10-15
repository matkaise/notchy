import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

export const Waveform = GObject.registerClass(class NotchyWaveform extends St.DrawingArea {
    _init(spectrum, width = 54, height = 24) {
        super._init({width, height, style_class: 'notchy-waveform', y_align: Clutter.ActorAlign.CENTER});
        this.spectrum = spectrum;
        const unsubscribe = spectrum.subscribe(() => { if (this.is_mapped()) this.queue_repaint(); });
        this.connect('destroy', () => { unsubscribe(); this.spectrum = null; });
        this.connect('repaint', () => this.draw());
    }
    draw() {
        const context = this.get_context(), [width, height] = this.get_surface_size();
        try {
            const levels = this.spectrum?.levels ?? Array(12).fill(0), color = this.get_theme_node().get_foreground_color();
            context.setSourceRGBA(color.red / 255, color.green / 255, color.blue / 255, color.alpha / 255);
            context.setLineWidth(Math.max(1.5, width / 30)); context.setLineCap(Cairo.LineCap.ROUND);
            for (let i = 0; i < 12; i++) {
                const x = (i + 0.5) * width / 12, bar = Math.max(2, levels[i] * (height - 3));
                context.moveTo(x, (height - bar) / 2); context.lineTo(x, (height + bar) / 2); context.stroke();
            }
        } finally { context.$dispose(); }
    }
});
