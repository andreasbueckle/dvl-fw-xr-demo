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
  Engine,
  HemisphericLight,
  Mesh,
  MeshBuilder,
  Node,
  Scene,
  StandardMaterial,
  Vector3,
  VertexBuffer,
  WebXRState,
} from '@babylonjs/core';
import { AdvancedDynamicTexture, Button, Control, StackPanel } from '@babylonjs/gui';
import * as anu from '@jpmorganchase/anu';
import { scaleBand, scaleLinear, scaleOrdinal } from 'd3-scale';
import { Bar, generateBars, generateSurface, loadSpotify, QUARTERS, REGIONS, SpotifyColumns } from './data';

type ChartType = 'scatter' | 'bar' | 'surface';

const CHARTS: { id: ChartType; label: string }[] = [
  { id: 'scatter', label: 'Spotify' },
  { id: 'bar', label: 'Bar' },
  { id: 'surface', label: 'Surface' },
];

// Every chart fills a 1m cube whose centre sits at roughly eye height.
const CHART_CENTER_Y = 1.2;
const VR_IDLE_STATUS = 'Click the goggles icon (bottom right) to enter VR.';

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
   * points, separate meshes would be far too slow, so all points are thin instances of one small box:
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

    const points = MeshBuilder.CreateBox('spotify-points', { size: 0.005 }, scene);
    points.parent = root;
    const mat = new StandardMaterial('spotify-mat', scene);
    mat.specularColor = Color3.Black();
    points.material = mat;
    // Picking against 130k instances would make every VR controller ray expensive.
    points.isPickable = false;

    const matrices = new Float32Array(count * 16);
    const colors = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const m = i * 16;
      matrices[m] = matrices[m + 5] = matrices[m + 10] = matrices[m + 15] = 1;
      matrices[m + 12] = scaleX(data.danceability[i]);
      matrices[m + 13] = scaleY(data.energy[i]);
      matrices[m + 14] = scaleZ(data.popularity[i]);
      const c = viridis(scaleC(data.duration_ms[i] / 60000));
      colors.set([c.r, c.g, c.b, 1], i * 4);
    }
    points.thinInstanceSetBuffer('matrix', matrices, 16, true);
    points.thinInstanceSetBuffer('color', colors, 4, true);
    points.thinInstanceRefreshBoundingInfo();

    anu.createAxes('scatter-axes', scene, { parent: chart, scale: { x: scaleX, y: scaleY, z: scaleZ } });
    addAxisTitles(scene, root, { x: 'Danceability', y: 'Energy', z: 'Popularity' });
    return root;
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
