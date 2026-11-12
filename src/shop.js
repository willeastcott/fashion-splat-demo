// The look header (name, piece count, total) and the size / bag controls. Nothing here is a
// real shop: the bag is a counter that lives in the page.

const SIZES = ['S', 'M', 'L', 'XL'];
const $ = id => document.getElementById(id);

export class Shop {
    /**
     * @param {object[]} defs - Figure definitions in outfit order (see src/figures.js).
     * @param {(n: number) => string} formatPrice - Price formatter.
     */
    constructor(defs, formatPrice) {
        this.defs = defs;
        this.formatPrice = formatPrice;
        // a piece with two callouts (front and back) is counted once
        const priced = d => d.callouts.filter(c => c.id && c.price && !c.of);
        this.totals = defs.map(d => priced(d).reduce((n, c) => n + c.price, 0));
        this.pieces = defs.map(d => priced(d).length);

        this.el = {
            look: $('look'), index: $('lookIndex'), name: $('lookName'), pieces: $('lookPieces'),
            total: $('lookTotal'), sizes: $('sizes'), add: $('add'), bag: $('bag')
        };
        this.shown = -1;
        this.bag = 0;
        this._total = '';
        this._swap = 0;

        const sizeButtons = SIZES.map((size) => {
            const b = document.createElement('button');
            b.textContent = size;
            b.classList.toggle('active', size === 'M');
            b.addEventListener('click', () => sizeButtons.forEach(o => o.classList.toggle('active', o === b)));
            this.el.sizes.appendChild(b);
            return b;
        });

        this.el.add.addEventListener('click', () => {
            this.bag++;
            this.el.bag.textContent = `Bag (${this.bag})`;
            this.el.add.textContent = 'Added to bag';
            this.el.add.classList.add('done');
            clearTimeout(this._added);
            this._added = setTimeout(() => this._resetAdd(), 1600);
        });
    }

    _resetAdd() {
        clearTimeout(this._added);
        this.el.add.textContent = 'Add look to bag';
        this.el.add.classList.remove('done');
    }

    _write(index) {
        const n = String(index + 1).padStart(2, '0');
        const of = String(this.defs.length).padStart(2, '0');
        this.el.index.textContent = `Look ${n} / ${of}`;
        this.el.name.textContent = this.defs[index].look.name;
        this.el.pieces.textContent = `${this.pieces[index]} pieces`;
    }

    /** @param {import('./morph.js').Morph} morph - Morph, already updated for this frame. */
    update(morph) {
        const target = morph.busy ? morph.to : morph.from;
        if (target !== this.shown) {
            if (this.shown < 0) {
                this._write(target);
            } else {
                // let the old name drop away before the new one comes in
                const token = ++this._swap;
                this.el.look.classList.add('out');
                this._resetAdd();
                setTimeout(() => {
                    if (token !== this._swap) return;
                    this._write(target);
                    this.el.look.classList.remove('out');
                }, 200);
            }
            this.shown = target;
        }

        // the total counts across to the new outfit's as the morph runs
        const a = this.totals[morph.from], b = this.totals[morph.to];
        const text = this.formatPrice(Math.round(morph.busy ? a + (b - a) * morph.blend : a));
        if (text !== this._total) {
            this._total = text;
            this.el.total.textContent = text;
        }
    }
}
