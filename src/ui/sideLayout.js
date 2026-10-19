// Where the indicators beside the notch go (AirPods, AI agents, …): pure
// layout logic without GNOME imports, covered by the Node tests. The actors
// live in src/ui/sideIndicators.js.
//
// Rules:
// - The notch stays where it is: both sides are made equally wide (the
//   narrower one is padded), so the clock remains centred however many
//   indicators there are, and no indicator widens the notch itself.
// - An indicator keeps its side once placed; no reshuffle on status events.
//   A new one goes where less is used (where more room is left).
// - Sides are only rebalanced when they differ by two or more indicators
//   (after some left), and the moved one is the newest of the fuller side.
// - Each side holds at most `capacity` pixels (the room between the notch and
//   GNOME's other panel items, less a margin). What does not fit spills to the
//   other side if there is room, else gathers in one "+N" group per side; the
//   most urgent (waiting, error, AirPods) stay visible.
// - Nothing is ever drawn beyond `capacity`, not even the group: a side too
//   narrow for the group shows nothing at all (groups.side is false), rather
//   than covering GNOME's or another extension's panel items.

export function planSides(items, capacity, previous = new Map(), {auto = true, spacing = 6, groupWidth = 30} = {}) {
    const ordered = [...items].sort((a, b) => a.order - b.order);
    const sides = new Map(), used = {left: 0, right: 0}, count = {left: 0, right: 0};
    const room = {left: capacity.left ?? capacity, right: capacity.right ?? capacity};
    const add = (side, item) => { used[side] += item.width + (count[side] ? spacing : 0); count[side]++; sides.set(item.id, side); };
    const take = (side, item) => { count[side]--; used[side] -= item.width + (count[side] ? spacing : 0); sides.delete(item.id); };
    // 1. Fixed and remembered sides first, then new ones where there is more room.
    for (const item of ordered) {
        const fixed = item.preferred === 'left' || item.preferred === 'right' ? item.preferred : null;
        const known = previous.get(item.id);
        if (fixed) add(fixed, item);
        else if (known && auto) add(known, item);
    }
    for (const item of ordered) {
        if (sides.has(item.id)) continue;
        let side = 'right';
        if (auto) side = used.left < used.right ? 'left' : used.right < used.left ? 'right' : room.left - used.left >= room.right - used.right ? 'left' : 'right';
        add(side, item);
    }
    // 2. Rebalance automatic ones when the sides drift two or more apart.
    const movable = side => ordered.filter(i => sides.get(i.id) === side && !(i.preferred === 'left' || i.preferred === 'right')).at(-1);
    for (let guard = 0; auto && guard < items.length && Math.abs(count.left - count.right) >= 2; guard++) {
        const from = count.left > count.right ? 'left' : 'right', to = from === 'left' ? 'right' : 'left', item = movable(from);
        if (!item) break;
        take(from, item); add(to, item);
    }
    // 3. Fit: spill to the other side, then group the least urgent.
    const hidden = {left: [], right: []};
    const onSide = side => ordered.filter(i => sides.get(i.id) === side);
    for (const side of ['left', 'right']) {
        const other = side === 'left' ? 'right' : 'left';
        while (used[side] > room[side] && auto) {
            const candidates = onSide(side).filter(i => !(i.preferred === 'left' || i.preferred === 'right'));
            const item = candidates.sort((a, b) => a.priority - b.priority || b.order - a.order)[0];
            if (!item || used[other] + (count[other] ? spacing : 0) + item.width > room[other]) break;
            take(side, item); add(other, item);
        }
    }
    const groups = {left: false, right: false};
    for (const side of ['left', 'right']) {
        const members = onSide(side);
        if (used[side] <= room[side]) continue;
        // Keep the most urgent that fit beside a "+N" group.
        const keep = [...members].sort((a, b) => b.priority - a.priority || a.order - b.order);
        const visible = new Set();
        let width = 0;
        if (groupWidth <= room[side]) {
            width = groupWidth;
            for (const item of keep) {
                if (width + spacing + item.width <= room[side]) { width += spacing + item.width; visible.add(item.id); }
            }
            groups[side] = true;
        }
        hidden[side] = members.filter(i => !visible.has(i.id)).map(i => i.id);
        used[side] = width;
    }
    const show = side => onSide(side).filter(i => !hidden[side].includes(i.id)).map(i => i.id);
    return {sides, visible: {left: show('left'), right: show('right')}, hidden, groups, used, width: Math.max(used.left, used.right)};
}
