/* ---------------------------------------------------------------------------
 * Tank selection screen shown at boot. Pick your vehicle; the AI takes the
 * other one. Pure DOM overlay — the 3D battlefield idles behind it.
 * ------------------------------------------------------------------------ */

import { TankSpec, SPECS } from '../tank/config';

export class Menu {
  private readonly root: HTMLDivElement;

  constructor(container: HTMLElement, onSelect: (spec: TankSpec) => void) {
    this.root = document.createElement('div');
    this.root.id = 'menu';
    this.root.innerHTML = /* html */ `
      <div id="menu-inner">
        <h1>PANZER DUEL · 1944</h1>
        <p class="menu-sub">Choose your tank — the other one is hunting you.</p>
        <div id="menu-cards">
          <div class="card" data-tank="tiger">
            <div class="card-silhouette">▛▀▜▄▖</div>
            <h2>TIGER I</h2>
            <div class="card-role">Heavy tank — armor &amp; firepower</div>
            <ul>
              <li>8.8cm KwK 36 L/56 · penetrates anywhere</li>
              <li>100 mm frontal armor</li>
              <li>57 t · 40 km/h · slow turret</li>
              <li>Doctrine: stand off and snipe</li>
            </ul>
          </div>
          <div class="card" data-tank="t34">
            <div class="card-silhouette">▗▄▀▀▙▖</div>
            <h2>T-34-85</h2>
            <div class="card-role">Medium tank — speed &amp; slopes</div>
            <ul>
              <li>85mm ZiS-S-53 · must close or flank</li>
              <li>45 mm @ 60° sloped armor</li>
              <li>32 t · 53 km/h · fast turret</li>
              <li>Doctrine: keep moving, hit the sides</li>
            </ul>
          </div>
        </div>
        <p class="menu-hint">First kill wins. Watch the minimap.</p>
      </div>
    `;
    container.appendChild(this.root);

    this.root.querySelectorAll<HTMLElement>('.card').forEach((card) => {
      card.addEventListener('click', () => {
        const id = card.dataset.tank as 'tiger' | 't34';
        this.hide();
        onSelect(SPECS[id]);
      });
    });
  }

  private hide(): void {
    this.root.classList.add('hidden');
    setTimeout(() => this.root.remove(), 600);
  }
}
