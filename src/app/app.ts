import { Component } from '@angular/core';
import { ChartsXr } from './charts-xr';

@Component({
  selector: 'app-root',
  imports: [ChartsXr],
  // Babylon.js + Anu are several MB, so load them in a lazy chunk after first paint.
  template: `
    @defer {
      <app-charts-xr />
    } @placeholder {
      <p class="loading">Loading 3D scene…</p>
    }
  `,
  styles: `
    :host { display: block; height: 100vh; }
    .loading { margin: 0; padding: 16px; color: #ccc; font: 14px system-ui, sans-serif; }
  `,
})
export class App {}
