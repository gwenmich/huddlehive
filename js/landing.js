(() => {
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const tickerItems = [
        {
            action: 'You logged',
            count: '4,320 mins streamed.',
            impact: 'Artists made £0.64.',
        },
        {
            action: 'You logged',
            count: '12 albums bought.',
            impact: 'Artists made £96.',
        },
        {
            action: 'You logged',
            count: '8 concerts attended.',
            impact: 'Artists made £560.',
        },
        {
            action: 'You logged',
            count: '3 merch drops bought.',
            impact: 'Artists made £90.',
        },
    ];

    const initHeroTicker = () => {
        const ticker = document.querySelector('.hero-ticker');
        if (!ticker || prefersReducedMotion) return;

        const action = ticker.querySelector('[data-hero-ticker-action]');
        const count = ticker.querySelector('[data-hero-ticker-count]');
        const impact = ticker.querySelector('[data-hero-ticker-impact]');
        if (!action || !count || !impact) return;

        let activeIndex = 0;

        window.setInterval(() => {
            activeIndex = (activeIndex + 1) % tickerItems.length;
            ticker.classList.add('is-changing');

            window.setTimeout(() => {
                const item = tickerItems[activeIndex];
                action.textContent = item.action;
                count.textContent = item.count;
                impact.textContent = item.impact;
                ticker.classList.remove('is-changing');
            }, 280);
        }, 2800);
    };

    initHeroTicker();

    const carousel = document.querySelector('[data-artist-carousel]');
    if (!carousel) return;

    const track = carousel.querySelector('.artist-carousel-track');
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
