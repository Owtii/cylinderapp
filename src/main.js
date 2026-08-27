import './styles.css';
import { Game } from './game/game.js';

const appRoot = document.getElementById('app');
const hudRoot = document.getElementById('hud');
const screensRoot = document.getElementById('screens');

function fatal(message, detail) {
  screensRoot.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'fatal';
  const h = document.createElement('h1');
  h.textContent = 'TONNAGE CANNOT START';
  const p = document.createElement('p');
  p.textContent = message;
  box.appendChild(h);
  box.appendChild(p);
  if (detail) {
    const pre = document.createElement('pre');
    pre.textContent = String(detail);
    box.appendChild(pre);
  }
  screensRoot.appendChild(box);
}

const game = new Game(appRoot, hudRoot, screensRoot);
window.__TONNAGE__ = game;

game.boot().catch((err) => {
  console.error(err);
  fatal(
    'This browser could not start a WebGPU or WebGL2 context. Try a recent Chrome, Edge, '
    + 'Firefox or Safari, and make sure hardware acceleration is enabled.',
    err && err.message,
  );
});

// Keep the page from scrolling or zooming under a drag on mobile.
document.addEventListener('touchmove', (e) => {
  if (e.touches.length > 1) e.preventDefault();
}, { passive: false });
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('contextmenu', (e) => {
  if (e.target && e.target.tagName === 'CANVAS') e.preventDefault();
});
