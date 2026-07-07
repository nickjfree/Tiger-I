/* ---------------------------------------------------------------------------
 * Tank selection screen shown at boot. Pick your vehicle; the AI takes the
 * other one. Pure DOM overlay — the 3D battlefield idles behind it.
 * ------------------------------------------------------------------------ */

import { TankSpec, SPECS } from '../tank/config';

export type MenuChoice =
  | { mode: 'sp'; spec: TankSpec }
  | { mode: 'mp'; spec: TankSpec; name: string };

export class Menu {
  private readonly root: HTMLDivElement;
  private selected: 'tiger' | 't34' = 'tiger';

  constructor(container: HTMLElement, onSelect: (choice: MenuChoice) => void) {
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
        <div id="menu-actions">
          <button id="btn-sp">⚔ &nbsp;DUEL THE AI</button>
          <div id="mp-row">
            <input id="mp-name" maxlength="16" placeholder="Your name" />
            <button id="btn-mp">🌐 &nbsp;JOIN ONLINE BATTLE</button>
          </div>
        </div>
        <p class="menu-hint">Duel: first kill wins. Online: one room, 8 commanders + an AI prowler.</p>
      </div>
    `;
    container.appendChild(this.root);

    const cards = this.root.querySelectorAll<HTMLElement>('.card');
    const select = (id: 'tiger' | 't34'): void => {
      this.selected = id;
      cards.forEach((c) => c.classList.toggle('selected', c.dataset.tank === id));
    };
    cards.forEach((card) => {
      card.addEventListener('click', () => select(card.dataset.tank as 'tiger' | 't34'));
    });
    select('tiger');

    const nameInput = this.root.querySelector('#mp-name') as HTMLInputElement;
    nameInput.value = localStorage.getItem('panzer-name') ?? '';

    (this.root.querySelector('#btn-sp') as HTMLElement).addEventListener('click', () => {
      this.hide();
      onSelect({ mode: 'sp', spec: SPECS[this.selected] });
    });
    (this.root.querySelector('#btn-mp') as HTMLElement).addEventListener('click', () => {
      const name = nameInput.value.trim() || 'Kommandant';
      localStorage.setItem('panzer-name', name);
      this.hide();
      onSelect({ mode: 'mp', spec: SPECS[this.selected], name });
    });
  }

  /** Re-show after a failed connection. */
  show(): void {
    this.root.classList.remove('hidden');
  }

  private hide(): void {
    this.root.classList.add('hidden');
  }
}
