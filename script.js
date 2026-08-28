// Footer year
document.getElementById('year').textContent = new Date().getFullYear();

// Scroll-reveal for elements marked .reveal. Content is visible by default
// (see styles.css) — this only ADDS a subtle entrance animation on top,
// and never leaves anything permanently hidden if something goes wrong.
const revealEls = document.querySelectorAll('.reveal');
if ('IntersectionObserver' in window && revealEls.length) {
  document.documentElement.classList.add('js-reveal-ready');

  const revealAll = () => revealEls.forEach((el) => el.classList.add('in'));

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.12, rootMargin: '0px 0px -60px 0px' }
  );
  revealEls.forEach((el) => observer.observe(el));

  // Safety net: if anything is still hidden after a few seconds (e.g. the
  // observer missed an element, or scroll timing was unusual), just show
  // it instead of leaving a blank gap on the page.
  setTimeout(revealAll, 4000);
}

// Mobile nav toggle: shows/hides the nav links as a dropdown panel
const navToggle = document.getElementById('navToggle');
const navLinks = document.querySelector('.nav-links');
if (navToggle && navLinks) {
  navToggle.addEventListener('click', () => {
    const isOpen = navLinks.classList.toggle('open');
    navToggle.setAttribute('aria-expanded', String(isOpen));
  });

  navLinks.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', () => navLinks.classList.remove('open'));
  });
}
