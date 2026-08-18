/*!
 * arrow-field.js
 * Reusable "vector field" cursor background — canvas-based, sprite-blitted.
 * Multiple independent instances per page, each configured via data-*
 * attributes on its own <canvas data-arrow-field> element.
 *
 * Usage (drop into a Webflow Embed element):
 *
 *   <canvas
 *     data-arrow-field
 *     data-mode="repel"        compass | repel | flow | windsock
 *     data-radius="400"        cursor influence radius, px
 *     data-density="48"        grid spacing, px (smaller = more arrows)
 *     data-color="239,90,42"   "r,g,b"
 *     data-alpha="0.16"        base opacity of resting arrows (0-1)
 *     data-ripple="true"       spawn a ripple on click/tap
 *     data-push="14"           repel/ripple positional displacement, px
 *     data-ease="0.16"         how quickly arrows settle toward target (0-1)
 *   ></canvas>
 *
 * The parent element should be `position: relative` with a defined height;
 * the canvas fills it via CSS (width:100%; height:100%; display:block).
 * Give the canvas `pointer-events:none` in CSS — the field tracks the
 * cursor globally, it doesn't need to receive events itself, and this
 * guarantees it never blocks clicks on real content in front of it.
 *
 * Library auto-inits every [data-arrow-field] canvas on DOMContentLoaded.
 * Manual control is also available: window.ArrowField.init(canvasEl, opts)
 * returns an instance with .destroy().
 */
(function () {
  'use strict';

  const TAU = Math.PI * 2;
  const REDUCE_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Merida arrow glyph, viewBox 0 0 67 68, tip points up (angle 0 == +x in
  // canvas terms, so drawArrow() adds +90deg to line the sprite up with it).
  const ARROW_D = 'M35 0L0 65.5C6 64.5 19.5 62.1 25.5 60.5C25.5 58.5 25 54.5 34 39.5C41.2 50.3 42.3333 58.3333 42 61L67 67.5L35 0Z';
  const arrowPath = new Path2D(ARROW_D);
  const VB_W = 67, VB_H = 68;
  const VB_ASPECT = VB_W / VB_H;

  // ---- shared sprite cache, keyed by "r,g,b" ------------------------------
  // Rasterizing the path is the expensive part; every instance that shares a
  // color shares a sprite instead of re-rasterizing it.
  const spriteCache = new Map();
  function getSprite(rgb) {
    if (spriteCache.has(rgb)) return spriteCache.get(rgb);
    const SS = 128; // sprite supersample size, px
    const off = document.createElement('canvas');
    off.width = SS; off.height = SS;
    const octx = off.getContext('2d');
    const scale = (SS * 0.86) / Math.max(VB_W, VB_H);
    octx.translate((SS - VB_W * scale) / 2, (SS - VB_H * scale) / 2);
    octx.scale(scale, scale);
    octx.fillStyle = `rgb(${rgb})`;
    octx.fill(arrowPath);
    spriteCache.set(rgb, off);
    return off;
  }

  // ---- shared pointer tracker ---------------------------------------------
  // One global listener; each instance converts to local coords using its
  // own canvas rect. Keeps the canvas itself pointer-events:none-able.
  const pointer = { x: -9999, y: -9999, px: -9999, py: -9999, active: false };
  window.addEventListener('pointermove', (e) => {
    pointer.px = pointer.x; pointer.py = pointer.y;
    pointer.x = e.clientX; pointer.y = e.clientY;
    pointer.active = true;
  }, { passive: true });
  window.addEventListener('pointerleave', () => { pointer.active = false; }, { passive: true });

  const clickTargets = new Set();
  window.addEventListener('pointerdown', (e) => {
    clickTargets.forEach((inst) => inst._onPointerDown(e));
  });

  // ---- math helpers --------------------------------------------------------
  const lerpAngle = (a, b, t) => {
    const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
    return a + d * t;
  };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const noise = (x, y, t) =>
    Math.sin(x * 0.6 + t) * 0.5 +
    Math.sin(y * 0.7 - t * 0.8) * 0.3 +
    Math.sin((x + y) * 0.35 + t * 1.3) * 0.2;

  // ---- one field instance ---------------------------------------------------
  class ArrowField {
    constructor(canvas, opts) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.opts = opts;
      this.sprite = getSprite(opts.color);
      this.arrows = [];
      this.ripples = [];
      this.W = 0; this.H = 0; this.DPR = 1;
      this.running = false;
      this._raf = null;
      this._last = performance.now();

      this._onResize = this._onResize.bind(this);
      this._frame = this._frame.bind(this);

      this._ro = new ResizeObserver(this._onResize);
      this._ro.observe(canvas);
      this._onResize();

      // Two independent pause reasons — scrolled off screen, and tab
      // hidden — each tracked separately so one can't clobber the other.
      // Only run when BOTH say "yes, animate."
      this._isIntersecting = false;
      this._updateRunState = this._updateRunState.bind(this);

      this._io = new IntersectionObserver((entries) => {
        this._isIntersecting = entries[0].isIntersecting;
        this._updateRunState();
      }, { threshold: 0.01 });
      this._io.observe(canvas);

      if (opts.ripple) clickTargets.add(this);

      document.addEventListener('visibilitychange', this._updateRunState);
    }

    _updateRunState() {
      if (this._isIntersecting && !document.hidden) this.start();
      else this.stop();
    }

    _onPointerDown(e) {
      const rect = this.canvas.getBoundingClientRect();
      this.ripples.push({ x: e.clientX - rect.left, y: e.clientY - rect.top, t: 0 });
    }

    _onResize() {
      const rect = this.canvas.getBoundingClientRect();
      this.DPR = Math.min(window.devicePixelRatio || 1, 2);
      this.W = Math.max(1, Math.round(rect.width));
      this.H = Math.max(1, Math.round(rect.height));
      this.canvas.width = this.W * this.DPR;
      this.canvas.height = this.H * this.DPR;
      this.ctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);
      this._buildGrid();
    }

    _buildGrid() {
      const { gap } = this.opts;
      this.arrows = [];
      const cols = Math.ceil(this.W / gap) + 1;
      const rows = Math.ceil(this.H / gap) + 1;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const jx = (Math.random() - 0.5) * gap * 0.5;
          const jy = (Math.random() - 0.5) * gap * 0.5;
          const base = Math.random() * TAU;
          this.arrows.push({
            x: c * gap + jx, y: r * gap + jy,
            base, angle: base,
            ox: 0, oy: 0, glow: 0,
            size: 13 + Math.random() * 5,
          });
        }
      }
    }

    start() {
      if (this.running) return;
      this.running = true;
      this._last = performance.now();
      this._raf = requestAnimationFrame(this._frame);
    }

    stop() {
      this.running = false;
      if (this._raf) cancelAnimationFrame(this._raf);
      this._raf = null;
    }

    destroy() {
      this.stop();
      this._ro.disconnect();
      this._io.disconnect();
      clickTargets.delete(this);
      document.removeEventListener('visibilitychange', this._updateRunState);
    }

    _drawArrow(a, alpha) {
      const ctx = this.ctx;
      const h = a.size, w = h * VB_ASPECT;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(a.x + a.ox, a.y + a.oy);
      ctx.rotate(a.angle + Math.PI / 2);
      ctx.drawImage(this.sprite, -w / 2, -h / 2, w, h);
      ctx.restore();
    }

    _frame(now) {
      if (!this.running) return;
      const dt = Math.min((now - this._last) / 1000, 0.05);
      this._last = now;
      const t = now * 0.0004;
      const { mode, radius, alpha: baseAlpha, ease: easeCfg, push } = this.opts;

      const rect = this.canvas.getBoundingClientRect();
      const mx = pointer.x - rect.left, my = pointer.y - rect.top;
      const inViewport = pointer.active && mx > -radius && mx < this.W + radius && my > -radius && my < this.H + radius;

      // approximate pointer velocity (page-space delta is fine for direction)
      const vx = pointer.x - pointer.px, vy = pointer.y - pointer.py;
      const speed = Math.hypot(vx, vy);
      const moveAngle = Math.atan2(vy, vx);

      for (let i = this.ripples.length - 1; i >= 0; i--) {
        this.ripples[i].t += dt;
        if (this.ripples[i].t > 2.2) this.ripples.splice(i, 1);
      }

      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.W, this.H);
      const r2 = radius * radius;
      const ease = REDUCE_MOTION ? 0.06 : easeCfg;

      for (const a of this.arrows) {
        const dx = mx - a.x, dy = my - a.y;
        const dist2 = dx * dx + dy * dy;
        const inRange = inViewport && dist2 < r2;
        const infl = inRange ? (1 - Math.sqrt(dist2) / radius) : 0;
        const soft = infl * infl * (3 - 2 * infl);

        let target = a.base;
        let targetOx = 0, targetOy = 0;

        if (mode === 'compass') {
          if (inRange) target = lerpAngle(a.base, Math.atan2(dy, dx), soft);
        } else if (mode === 'repel') {
          if (inRange) {
            target = lerpAngle(a.base, Math.atan2(-dy, -dx), soft);
            const d = Math.sqrt(dist2) || 1;
            targetOx = (-dx / d) * soft * push;
            targetOy = (-dy / d) * soft * push;
          }
        } else if (mode === 'flow') {
          const flow = noise(a.x * 0.004, a.y * 0.004, t * 3) * Math.PI;
          target = lerpAngle(a.base, a.base + flow, 0.6);
          if (inRange) {
            const swirl = Math.atan2(dy, dx) + Math.PI / 2;
            target = lerpAngle(target, swirl, soft);
          }
        } else if (mode === 'windsock') {
          if (speed > 0.4) {
            const globalPull = clamp(speed / 40, 0, 0.5);
            target = lerpAngle(a.base, moveAngle, globalPull + soft * 0.5);
          }
        }

        if (this.ripples.length) {
          for (const rp of this.ripples) {
            const rd = Math.hypot(a.x - rp.x, a.y - rp.y);
            const front = rp.t * 520;
            const band = 90;
            const edge = 1 - Math.min(Math.abs(rd - front) / band, 1);
            if (edge > 0) {
              const fade = 1 - rp.t / 2.2;
              const pulse = edge * fade;
              target = lerpAngle(target, Math.atan2(a.y - rp.y, a.x - rp.x), pulse);
              const d = rd || 1;
              targetOx += ((a.x - rp.x) / d) * pulse * push;
              targetOy += ((a.y - rp.y) / d) * pulse * push;
            }
          }
        }

        a.angle = lerpAngle(a.angle, target, ease);
        a.ox += (targetOx - a.ox) * ease;
        a.oy += (targetOy - a.oy) * ease;
        a.glow += (soft - a.glow) * 0.12;

        this._drawArrow(a, baseAlpha + a.glow * 0.6);
      }

      this._raf = requestAnimationFrame(this._frame);
    }
  }

  // ---- option parsing --------------------------------------------------------
  function parseOptions(canvas) {
    const d = canvas.dataset;
    return {
      mode: d.mode || 'compass',
      radius: +d.radius || 240,
      gap: +d.density || 48,
      color: (d.color || '148,160,224').trim(),
      alpha: d.alpha !== undefined ? +d.alpha : 0.16,
      ripple: d.ripple !== 'false',
      push: d.push !== undefined ? +d.push : 14,
      ease: d.ease !== undefined ? +d.ease : 0.16,
    };
  }

  function init(canvas, userOpts) {
    const opts = Object.assign(parseOptions(canvas), userOpts || {});
    return new ArrowField(canvas, opts);
  }

  function initAll(root) {
    const scope = root || document;
    return Array.from(scope.querySelectorAll('[data-arrow-field]')).map((c) => init(c));
  }

  window.ArrowField = { init, initAll };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initAll());
  } else {
    initAll();
  }
})();
