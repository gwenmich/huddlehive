(() => {
    const carousel = document.querySelector('[data-artist-carousel]');
    if (!carousel) return;

    const track = carousel.querySelector('.artist-carousel-track');
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!track || prefersReducedMotion) return;

    const cards = Array.from(track.children);
    if (!cards.length) return;

    cards.forEach((card) => {
        const clone = card.cloneNode(true);
        clone.setAttribute('aria-hidden', 'true');
        track.appendChild(clone);
    });

    carousel.dataset.animated = 'true';
})();
