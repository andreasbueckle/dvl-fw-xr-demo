import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import {
  ArcRotateCamera,
  Color3,
  DynamicTexture,
  Engine,
  HemisphericLight,
  Matrix,
  Mesh,
  MeshBuilder,
  Node,
  Ray,
  Scene,
  StandardMaterial,
  Vector3,
  VertexBuffer,
  WebXRDefaultExperience,
  WebXRState,
} from '@babylonjs/core';
import { AdvancedDynamicTexture, Button, Control, Rectangle, StackPanel, TextBlock, type TextWrapping } from '@babylonjs/gui';
import * as anu from '@jpmorganchase/anu';
import { scaleBand, scaleLinear, scaleOrdinal } from 'd3-scale';
import {
  Bar,
  generateBars,
  generateSurface,
  loadSpotify,
  loadSpotifyNames,
  QUARTERS,
  REGIONS,
  SpotifyColumns,
  SpotifyNames,
} from './data';
import { PointGrid } from './point-grid';

type ChartType = 'scatter' | 'bar' | 'surface';

const CHARTS: { id: ChartType; label: string }[] = [
  { id: 'scatter', label: 'Spotify' },
  { id: 'bar', label: 'Bar' },
  { id: 'surface', label: 'Surface' },
];

// Every chart fills a 1m cube whose centre sits at roughly eye height.
const CHART_CENTER_Y = 1.2;
const VR_IDLE_STATUS = 'Click the goggles icon (bottom right) to enter VR.';
const POINT_DIAMETER = 0.006;

@Component({
  selector: 'app-charts-xr',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <canvas #canvas></canvas>
    <div class="status">{{ status() }}</div>
    <div class="switcher" role="group" aria-label="Chart type">
      @for (c of charts; track c.id) {
        <button type="button" [class.active]="chart() === c.id" [attr.aria-pressed]="chart() === c.id" (click)="chart.set(c.id)">
          {{ c.label }}
        </button>
      }
    </div>
  `,
  styles: `
    :host { display: block; position: relative; width: 100%; height: 100%; font: 13px system-ui, sans-serif; }
    canvas { width: 100%; height: 100%; display: block; outline: none; touch-action: none; }
    .status {
      position: absolute; top: 12px; left: 12px; padding: 6px 10px;
      color: #fff; background: rgb(0 0 0 / 0.55); border-radius: 6px;
    }
    .switcher {
      position: absolute; top: 12px; right: 12px; display: flex; gap: 4px; padding: 4px;
      background: rgb(0 0 0 / 0.55); border-radius: 8px;
    }
    .switcher button {
      font: inherit; color: #ddd; background: transparent; border: 0; border-radius: 5px;
      padding: 6px 12px; cursor: pointer;
    }
    .switcher button:hover { background: rgb(255 255 255 / 0.12); }
    .switcher button.active { background: #2f6fde; color: #fff; }
  `,
})
export class ChartsXr {
  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  protected readonly charts = CHARTS;
  protected readonly chart = signal<ChartType>('scatter');
  protected readonly status = signal('Loading…');
  private readonly views = signal<Record<ChartType, Node> | null>(null);
  private vrButtons: Partial<Record<ChartType, Button>> = {};
  private xr?: WebXRDefaultExperience;
  private pointerInside = false;

  constructor() {
    const destroyRef = inject(DestroyRef);

    // Show only the selected chart and keep the in-VR panel's highlight in sync with the HTML buttons.
    effect(() => {
      const active = this.chart();
      const views = this.views();
      if (!views) return;
      for (const { id } of CHARTS) {
        setChartEnabled(views[id], id === active);
        const button = this.vrButtons[id];
        if (button) button.background = id === active ? '#2f6fde' : '#333a';
      }
    });

    afterNextRender(() => {
      const engine = new Engine(this.canvas().nativeElement, true);
      const scene = this.createScene(engine);
      engine.runRenderLoop(() => scene.render());
      this.buildCharts(scene).then(() => this.enableXR(scene));
      const onResize = () => engine.resize();
      window.addEventListener('resize', onResize);
      destroyRef.onDestroy(() => {
        window.removeEventListener('resize', onResize);
        engine.dispose();
      });
    });
  }

  private createScene(engine: Engine): Scene {
    const scene = new Scene(engine);
    scene.clearColor.set(0.08, 0.09, 0.12, 1);
    const light = new HemisphericLight('light', new Vector3(0, 10, 0), scene);
    light.groundColor = new Color3(0.4, 0.4, 0.4);

    const camera = new ArcRotateCamera('cam', -Math.PI / 4, Math.PI / 2.5, 2.5, new Vector3(0, CHART_CENTER_Y, 0), scene);
    camera.wheelPrecision = 50;
    camera.minZ = 0.01;
    camera.attachControl(true);
    return scene;
  }

  private async buildCharts(scene: Scene): Promise<void> {
    this.status.set('Loading Spotify data…');
    let spotify: SpotifyColumns;
    try {
      spotify = await loadSpotify();
    } catch (err) {
      this.status.set(String(err instanceof Error ? err.message : err));
      throw err;
    }
    this.views.set({
      scatter: this.createScatter(scene, spotify),
      bar: this.createBar(scene),
      surface: this.createSurface(scene),
    });
    this.createVrPanel(scene);
  }

  /**
   * Danceability (x), energy (y), popularity (z) and duration (colour) for every track. With ~130k
   * points, separate meshes would be far too slow, so all points are thin instances of one small sphere:
   * a single draw call. Anu's bindThinInstance helpers allocate a Matrix per point (and 3x the
   * buffer), so the instance buffers are written directly here; Anu still provides the chart root,
   * axes and colour scale.
   */
  private createScatter(scene: Scene, data: SpotifyColumns): Node {
    const count = data.popularity.length;
    const scaleX = scaleLinear().domain([0, 1]).range([-0.5, 0.5]);
    const scaleY = scaleLinear().domain([0, 1]).range([-0.5, 0.5]);
    const scaleZ = scaleLinear().domain([0, 100]).range([-0.5, 0.5]);
    // Colour = duration in minutes. Durations run from seconds to over an hour, but the median is
    // ~3.4 min and 99% are under 10 min, so the scale stops at 10 min; longer tracks clamp to yellow.
    const viridis = anu.sequentialChromatic('Viridis').toColor3();
    const scaleC = scaleLinear().domain([0, 10]).range([0, 1]).clamp(true);

    const chart = anu.bind('cot', {}, [{}], scene);
    chart.positionY(CHART_CENTER_Y);
    const root = chart.selected[0];

    // A low-poly sphere: 130k instances of a smooth one would cost far more triangles than headsets can afford.
    const points = MeshBuilder.CreateSphere('spotify-points', { diameter: POINT_DIAMETER, segments: 4 }, scene);
    points.parent = root;
    const mat = new StandardMaterial('spotify-mat', scene);
    mat.specularColor = Color3.Black();
    points.material = mat;
    // Babylon's picking would test all 130k instances per ray; hover uses a PointGrid instead.
    points.isPickable = false;

    const matrices = new Float32Array(count * 16);
    const colors = new Float32Array(count * 4);
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const m = i * 16;
      positions.set([scaleX(data.danceability[i]), scaleY(data.energy[i]), scaleZ(data.popularity[i])], i * 3);
      matrices[m] = matrices[m + 5] = matrices[m + 10] = matrices[m + 15] = 1;
      matrices.set(positions.subarray(i * 3, i * 3 + 3), m + 12);
      const c = viridis(scaleC(data.duration_ms[i] / 60000));
      colors.set([c.r, c.g, c.b, 1], i * 4);
    }
    points.thinInstanceSetBuffer('matrix', matrices, 16, true);
    points.thinInstanceSetBuffer('color', colors, 4, true);
    points.thinInstanceRefreshBoundingInfo();

    anu.createAxes('scatter-axes', scene, { parent: chart, scale: { x: scaleX, y: scaleY, z: scaleZ } });
    addAxisTitles(scene, root, { x: 'Danceability', y: 'Energy', z: 'Popularity' });
    addColorLegend(scene, root, {
      title: 'Duration (min)',
      ticks: [0, 2, 4, 6, 8, 10],
      color: (minutes) => viridis(scaleC(minutes)),
      format: (minutes) => (minutes === 10 ? '10+' : String(minutes)),
      // Beside the chart's right-hand corner as seen from the default camera.
      position: new Vector3(0.8, 0, 0.8),
    });
    // Pick a little wider than the spheres themselves, which are only a few pixels across.
    this.setupHover(scene, points, positions, new PointGrid(positions, POINT_DIAMETER));
    return root;
  }

  /**
   * Details on demand: the track under the mouse, or under a VR controller's ray, is highlighted and
   * labelled with its name and artist. The label is part of the scene so it also works in VR.
   */
  private setupHover(scene: Scene, points: Mesh, positions: Float32Array, grid: PointGrid): void {
    const root = points.parent!;
    const highlight = MeshBuilder.CreateSphere('spotify-hover', { diameter: POINT_DIAMETER * 2.5, segments: 8 }, scene);
    highlight.parent = root;
    const mat = new StandardMaterial('spotify-hover-mat', scene);
    mat.emissiveColor = Color3.White();
    mat.disableLighting = true;
    highlight.material = mat;
    highlight.isPickable = false;
    // Rendering group 1 draws after the points with a cleared depth buffer, so nothing hides the hover.
    highlight.renderingGroupId = 1;
    highlight.setEnabled(false);
    const label = createHoverLabel(scene, root);

    let names: SpotifyNames | undefined;
    let current = -1;
    const show = (i: number) => {
      current = i;
      highlight.setEnabled(i >= 0);
      label.mesh.setEnabled(i >= 0);
      if (i < 0) return;
      const [x, y, z] = positions.subarray(i * 3, i * 3 + 3);
      highlight.position.set(x, y, z);
      label.mesh.position.set(x, y + 0.06, z);
      label.setText(names?.track[i] ?? 'Loading track names…', names?.artist[i] ?? '');
    };
    loadSpotifyNames()
      .then((n) => {
        names = n;
        if (current >= 0) show(current);
      })
      .catch((err) => console.error(err));

    const canvas = scene.getEngine().getRenderingCanvas()!;
    canvas.addEventListener('pointermove', () => (this.pointerInside = true));
    canvas.addEventListener('pointerleave', () => (this.pointerInside = false));
    const toLocal = new Matrix();
    scene.onBeforeRenderObservable.add(() => {
      let hit = -1;
      if (this.chart() === 'scatter') {
        points.getWorldMatrix().invertToRef(toLocal);
        for (const ray of this.pointerRays(scene)) {
          hit = grid.pick(Ray.Transform(ray, toLocal));
          if (hit >= 0) break;
        }
      }
      if (hit !== current) show(hit);
    });
  }

  /** World-space rays from the VR controllers when in VR, otherwise from the mouse. */
  private pointerRays(scene: Scene): Ray[] {
    if (this.xr?.baseExperience.state === WebXRState.IN_XR) {
      return this.xr.input.controllers.map((controller) => {
        const ray = new Ray(Vector3.Zero(), Vector3.Forward());
        controller.getWorldPointerRayToRef(ray);
        return ray;
      });
    }
    if (!this.pointerInside || !scene.activeCamera) return [];
    return [scene.createPickingRay(scene.pointerX, scene.pointerY, Matrix.Identity(), scene.activeCamera)];
  }

  private createBar(scene: Scene): Node {
    const data = generateBars();
    const scaleX = scaleBand().domain(QUARTERS).range([-0.5, 0.5]).paddingInner(1).paddingOuter(0.5);
    const scaleZ = scaleBand().domain(REGIONS).range([-0.5, 0.5]).paddingInner(1).paddingOuter(0.5);
    const scaleY = scaleLinear().domain([0, Math.max(...data.map((d) => d.value))]).range([0, 1]).nice();
    const scaleC = scaleOrdinal<string, StandardMaterial>().domain(REGIONS).range(categoryMaterials(scene, 'bar'));

    // Bars grow up from the floor of the 1m cube rather than from its centre.
    const chart = anu.bind('cot', {}, [{}], scene);
    chart.positionY(CHART_CENTER_Y - 0.5);
    chart
      .bind('box', { height: 1, width: 0.12, depth: 0.12 }, data)
      .positionX((d: Bar) => scaleX(d.quarter)!)
      .positionZ((d: Bar) => scaleZ(d.region)!)
      .scalingY((d: Bar) => scaleY(d.value))
      .positionY((d: Bar) => scaleY(d.value) / 2)
      .prop('material', (d: Bar) => scaleC(d.region));
    anu.createAxes('bar-axes', scene, { parent: chart, scale: { x: scaleX, y: scaleY, z: scaleZ } });
    return chart.selected[0];
  }

  private createSurface(scene: Scene): Node {
    const grid = generateSurface();
    const flat = grid.flat();
    // Data x/y span the floor plane (scene X/Z); the function value is the height (scene Y).
    const scaleX = scaleLinear().domain(extent(flat.map((d) => d.x))).range([-0.5, 0.5]);
    const scaleZ = scaleLinear().domain(extent(flat.map((d) => d.y))).range([-0.5, 0.5]);
    const scaleY = scaleLinear().domain(extent(flat.map((d) => d.z))).range([-0.5, 0.5]).nice();
    const color = anu.sequentialChromatic('Viridis').toColor3();
    const paths = grid.map((row) => row.map((d) => new Vector3(scaleX(d.x), scaleY(d.z), scaleZ(d.y))));

    const chart = anu.bind('cot', {}, [{}], scene);
    chart.positionY(CHART_CENTER_Y);
    chart.bind('ribbon', { pathArray: paths, sideOrientation: Mesh.DOUBLESIDE }).run((_d: unknown, node: Node) => {
      // Colour each vertex by its height.
      const mesh = node as Mesh;
      const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
      const colors: number[] = [];
      for (let p = 0; p < positions.length; p += 3) {
        const c = color(positions[p + 1] + 0.5);
        colors.push(c.r, c.g, c.b, 1);
      }
      mesh.setVerticesData(VertexBuffer.ColorKind, colors);
      const mat = new StandardMaterial('surface-mat', scene);
      mat.specularColor = Color3.Black();
      mesh.material = mat;
    });
    anu.createAxes('surface-axes', scene, { parent: chart, scale: { x: scaleX, y: scaleY, z: scaleZ } });
    return chart.selected[0];
  }

  /** HTML buttons are invisible inside an immersive session, so mirror them on a panel in the scene. */
  private createVrPanel(scene: Scene): void {
    const plane = MeshBuilder.CreatePlane('chart-switcher', { width: 0.6, height: 0.12 }, scene);
    // In front of the chart, on the side the default camera views it from, tilted up towards the viewer.
    plane.position = new Vector3(0.75, CHART_CENTER_Y - 0.65, -0.75);
    plane.rotation = new Vector3(Math.PI / 6, -Math.PI / 4, 0);

    const ui = AdvancedDynamicTexture.CreateForMesh(plane, 1000, 200);
    const row = new StackPanel();
    row.isVertical = false;
    row.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
    ui.addControl(row);

    for (const { id, label } of CHARTS) {
      const button = Button.CreateSimpleButton(`vr-${id}`, label);
      button.width = '320px';
      button.height = '180px';
      button.paddingLeft = button.paddingRight = '10px';
      button.color = 'white';
      button.fontSize = 64;
      button.cornerRadius = 20;
      button.thickness = 0;
      button.background = '#333a';
      button.onPointerUpObservable.add(() => this.chart.set(id));
      row.addControl(button);
      this.vrButtons[id] = button;
    }
    // The effect may already have run before the buttons existed; re-trigger it.
    this.views.update((v) => (v ? { ...v } : v));
  }

  private async enableXR(scene: Scene): Promise<void> {
    if (!navigator.xr || !(await navigator.xr.isSessionSupported('immersive-vr').catch(() => false))) {
      this.status.set(
        window.isSecureContext
          ? 'WebXR immersive-vr not available — showing desktop view.'
          : 'WebXR requires HTTPS (or localhost) — showing desktop view.',
      );
      return;
    }
    const ground = anu.create('ground', 'floor', { width: 6, height: 6 }, {}, scene);
    const xr = await scene.createDefaultXRExperienceAsync({ floorMeshes: [ground] });
    this.xr = xr;
    this.status.set(VR_IDLE_STATUS);
    xr.baseExperience.onStateChangedObservable.add((state) => {
      if (state === WebXRState.IN_XR) this.status.set('In VR');
      if (state === WebXRState.NOT_IN_XR) this.status.set(VR_IDLE_STATUS);
    });
  }
}

/**
 * Anu's PlaneText labels draw through their own text renderer and ignore their parents' enabled
 * state, so they have to be toggled individually alongside the chart's root node.
 */
function setChartEnabled(root: Node, enabled: boolean): void {
  root.setEnabled(enabled);
  for (const node of root.getDescendants(false)) {
    if (node instanceof anu.PlaneText) node.setEnabled(enabled);
  }
}

/** Anu axes have tick labels but no titles; place one beside each axis of the 1m chart cube. */
function addAxisTitles(scene: Scene, parent: Node, titles: { x: string; y: string; z: string }): void {
  const placements = [
    { text: titles.x, position: new Vector3(0, -0.66, -0.5), rotation: Vector3.Zero() },
    { text: titles.y, position: new Vector3(-0.72, 0, -0.5), rotation: new Vector3(0, 0, Math.PI / 2) },
    { text: titles.z, position: new Vector3(0.5, -0.66, 0), rotation: new Vector3(0, -Math.PI / 2, 0) },
  ];
  for (const { text, position, rotation } of placements) {
    const title = anu.createPlaneText(`title-${text}`, { text, size: 0.05, align: 'center' }, scene);
    title.parent = parent;
    title.position = position;
    title.rotation = rotation;
  }
}

/** A vertical colour ramp with tick labels, drawn once into a texture on a plane that turns to face the viewer. */
function addColorLegend(
  scene: Scene,
  parent: Node,
  opts: {
    title: string;
    ticks: number[];
    color: (value: number) => Color3;
    format: (value: number) => string;
    position: Vector3;
  },
): void {
  const [width, height] = [320, 640];
  const texture = new DynamicTexture('legend-tex', { width, height }, scene, true);
  texture.hasAlpha = true;
  const ctx = texture.getContext() as unknown as CanvasRenderingContext2D;
  ctx.fillStyle = 'rgb(0 0 0 / 0.55)';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 36px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(opts.title, width / 2, 50);

  const [top, bottom, barX, barWidth] = [110, height - 40, 70, 60];
  const lo = opts.ticks[0];
  const hi = opts.ticks[opts.ticks.length - 1];
  const yOf = (v: number) => bottom - ((v - lo) / (hi - lo)) * (bottom - top);
  const gradient = ctx.createLinearGradient(0, bottom, 0, top);
  for (let s = 0; s <= 16; s++) gradient.addColorStop(s / 16, opts.color(lo + ((hi - lo) * s) / 16).toHexString());
  ctx.fillStyle = gradient;
  ctx.fillRect(barX, top, barWidth, bottom - top);

  ctx.fillStyle = '#fff';
  ctx.font = '34px system-ui, sans-serif';
  ctx.textAlign = 'left';
  for (const v of opts.ticks) {
    const y = yOf(v);
    ctx.fillRect(barX + barWidth, y - 1.5, 14, 3);
    ctx.fillText(opts.format(v), barX + barWidth + 24, y);
  }
  texture.update();

  const plane = MeshBuilder.CreatePlane('legend', { width: 0.24, height: 0.48 }, scene);
  plane.parent = parent;
  plane.position = opts.position;
  plane.billboardMode = Mesh.BILLBOARDMODE_Y;
  plane.isPickable = false;
  const mat = new StandardMaterial('legend-mat', scene);
  mat.emissiveTexture = texture;
  mat.opacityTexture = texture;
  mat.disableLighting = true;
  plane.material = mat;
}

/** A two-line label (track, artist) on a plane that always faces the viewer. */
function createHoverLabel(scene: Scene, parent: Node): { mesh: Mesh; setText: (title: string, subtitle: string) => void } {
  const mesh = MeshBuilder.CreatePlane('hover-label', { width: 0.4, height: 0.1 }, scene);
  mesh.parent = parent;
  mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
  mesh.isPickable = false;
  mesh.renderingGroupId = 1;
  mesh.setEnabled(false);

  const ui = AdvancedDynamicTexture.CreateForMesh(mesh, 1024, 256);
  const box = new Rectangle();
  box.background = 'rgb(0 0 0 / 0.75)';
  box.cornerRadius = 24;
  box.thickness = 0;
  ui.addControl(box);
  const lines = new StackPanel();
  box.addControl(lines);
  const line = (fontSize: number, color: string, height: string) => {
    const text = new TextBlock();
    text.fontSize = fontSize;
    text.color = color;
    text.height = height;
    text.paddingLeft = text.paddingRight = '32px';
    text.textWrapping = 2 satisfies TextWrapping; // TextWrapping.Ellipsis (a const enum, unusable with isolatedModules)
    lines.addControl(text);
    return text;
  };
  const title = line(96, '#fff', '128px');
  const subtitle = line(72, '#bbb', '96px');
  title.fontWeight = 'bold';
  return {
    mesh,
    setText: (t, s) => {
      title.text = t;
      subtitle.text = s;
    },
  };
}

/** One shared material per category keeps draw calls low on standalone headsets. */
function categoryMaterials(scene: Scene, prefix: string): StandardMaterial[] {
  return anu.ordinalChromatic('d310').toColor3().map((color, i) => {
    const mat = new StandardMaterial(`${prefix}-${i}`, scene);
    mat.diffuseColor = color;
    mat.specularColor = Color3.Black();
    return mat;
  });
}

function extent(values: number[]): [number, number] {
  return [Math.min(...values), Math.max(...values)];
}
