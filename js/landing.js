(() => {
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const tickerItems = [
        {
            action: 'You streamed',
            count: '4,320 mins.',
            impact: 'Artists may keep ~£0.70.',
        },
        {
            action: 'You bought',
            count: '12 albums.',
            impact: 'Artists may keep ~£95.',
        },
        {
            action: 'You attended',
            count: '8 concerts.',
            impact: 'Artists may keep ~£80.',
        },
        {
            action: 'You bought',
            count: '3 merch drops.',
            impact: 'Artists may keep ~£36.',
        },
    ];

    const initHeroTicker = () => {
        const ticker = document.querySelector('.hero-ticker');
        if (!ticker) return;

        const action = ticker.querySelector('[data-hero-ticker-action]');
        const count = ticker.querySelector('[data-hero-ticker-count]');
        const impact = ticker.querySelector('[data-hero-ticker-impact]');
        if (!action || !count || !impact) return;

        let activeIndex = 0;

        window.setInterval(() => {
            activeIndex = (activeIndex + 1) % tickerItems.length;

            if (prefersReducedMotion) {
                updateTicker(tickerItems[activeIndex]);
                return;
            }

            ticker.classList.add('is-changing');

            window.setTimeout(() => {
                updateTicker(tickerItems[activeIndex]);
                ticker.classList.remove('is-changing');
            }, 280);
        }, 2800);

        function updateTicker(item) {
            action.textContent = item.action;
            count.textContent = item.count;
            impact.textContent = item.impact;
        }
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
