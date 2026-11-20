// Each split/merge owns its animations. A newer gesture cancels the previous
// one at its displayed width; stale completions never resize a retired pane.
export function createSplitMotion({ settled = () => {} } = {}) {
  let animations = [], owner = null, revision = 0;
  function cancel() {
    revision++;
    animations.forEach(animation => animation.cancel());animations = [];
    if (owner) delete owner.dataset.splitMotion;
    owner = null;
  }
  function capture(element) {
    const width = element?.getBoundingClientRect().width || 0;
    cancel();return width;
  }
  function play(element, fromWidth, { entering = null, restoring = false } = {}) {
    const targetWidth = element?.getBoundingClientRect().width || 0;
    if (!element?.animate || !fromWidth || !targetWidth || restoring ||
      globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const token = ++revision, options = { duration: 280, easing: 'cubic-bezier(.22,.72,.2,1)', fill: 'both' };
    owner = element;element.dataset.splitMotion = entering ? 'opening' : 'closing';
    // A relative endpoint follows the sidebar/window while it is resizing too.
    const destination = element.style.width || (entering ? 'calc(50% - 5px)' : '100%');
    const width = element.animate([{ width: fromWidth + 'px' }, { width: destination }], options);
    width.id = 'structboard-split-width';animations = [width];
    if (entering?.animate) {
      const reveal = entering.animate([{ opacity: 0, transform: 'translateX(24px)' }, { opacity: .94, transform: 'none' }], options);
      reveal.id = 'structboard-split-reveal';animations.push(reveal);
    }
    Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
      if (token !== revision) return;
      cancel();
      if (element.isConnected) settled();
    });
  }
  return { capture, play, cancel };
}
