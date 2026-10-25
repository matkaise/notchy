import Clutter from 'gi://Clutter';
import St from 'gi://St';
import {qrEncode} from '../qrcode.js';
import {icon} from './widgets.js';

// A QR code on a white rounded card, AirDrop's badge in its middle (level H
// keeps it readable, see tests/test_qrcode.py). setText() draws another link
// into the same actor.
export function qrWidget(size = 96, badge = 'notchy-airdrop-symbolic') {
    const card = new St.Widget({style_class: 'notchy-qr', layout_manager: new Clutter.BinLayout(), width: size, height: size, y_align: Clutter.ActorAlign.CENTER});
    const area = new St.DrawingArea({x_expand: true, y_expand: true});
    const mark = new St.Bin({style_class: 'notchy-qr-badge', width: Math.round(size / 4), height: Math.round(size / 4), x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
        child: icon(badge, Math.round(size / 7)), visible: false});
    card.add_child(area); card.add_child(mark);
    let code = null;
    area.connect('repaint', () => {
        const cr = area.get_context(), [w, h] = area.get_surface_size();
        try {
            if (!code) return;
            // Two light modules of margin inside the white card (the card is the rest of the quiet zone).
            const cells = code.size + 4, cell = Math.min(w, h) / cells, x0 = (w - cell * cells) / 2 + 2 * cell, y0 = (h - cell * cells) / 2 + 2 * cell;
            cr.setSourceRGBA(0, 0, 0, 1);
            for (let y = 0; y < code.size; y++) for (let x = 0; x < code.size; x++) if (code.modules[y][x]) cr.rectangle(x0 + x * cell, y0 + y * cell, cell + 0.25, cell + 0.25);
            cr.fill();
        } finally { cr.$dispose(); }
    });
    return {actor: card, area,
        get text() { return code?.text ?? ''; },
        setText(text) {
            if (code?.text === text) return;
            const encoded = text ? qrEncode(text, {ecl: 'H'}) : null;
            code = encoded ? {...encoded, text} : null;
            mark.visible = Boolean(code); card.opacity = code ? 255 : 90;
            area.queue_repaint();
        }};
}
