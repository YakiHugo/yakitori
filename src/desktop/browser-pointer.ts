import { BrowserControlError } from "../protocol/desktop-browser.ts"
import type {
  BrowserFrameBinding,
  BrowserReadCommand,
} from "./browser-frames.ts"

export type BrowserPoint = Readonly<{ x: number; y: number }>
type Matrix = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
]
const identity: Matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1]

function unavailable(): never {
  throw new BrowserControlError(
    "browser_input_unavailable",
    "The frame has no stable visible input point. Observe again before clicking.",
  )
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Chromium returned invalid pointer geometry.")
  return value as Record<string, unknown>
}

function multiply(a: Matrix, b: Matrix): Matrix {
  return a.map((_value, index) => {
    const row = Math.floor(index / 3),
      column = index % 3
    return [0, 1, 2].reduce(
      (sum, k) => sum + (a[row * 3 + k] ?? 0) * (b[k * 3 + column] ?? 0),
      0,
    )
  }) as Matrix
}

function inverse(m: Matrix): Matrix {
  const [a, b, c, d, e, f, g, h, i] = m
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) unavailable()
  return [
    e * i - f * h,
    c * h - b * i,
    b * f - c * e,
    f * g - d * i,
    a * i - c * g,
    c * d - a * f,
    d * h - e * g,
    b * g - a * h,
    a * e - b * d,
  ].map((v) => v / det) as Matrix
}

function mapPoint(m: Matrix, point: BrowserPoint): BrowserPoint {
  const w = m[6] * point.x + m[7] * point.y + m[8]
  if (!Number.isFinite(w) || Math.abs(w) < 1e-12) unavailable()
  const x = (m[0] * point.x + m[1] * point.y + m[2]) / w,
    y = (m[3] * point.x + m[4] * point.y + m[5]) / w
  if (!Number.isFinite(x) || !Number.isFinite(y)) unavailable()
  return { x, y }
}

function contentProjection(
  quad: unknown,
  width: unknown,
  height: unknown,
): Matrix {
  if (
    !Array.isArray(quad) ||
    quad.length !== 8 ||
    !quad.every((v) => typeof v === "number" && Number.isFinite(v))
  )
    throw new Error("Chromium returned an invalid frame content quad.")
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  )
    unavailable()
  const points = [0, 1, 2, 3].map((index) => ({
    x: quad[index * 2] as number,
    y: quad[index * 2 + 1] as number,
  }))
  let direction = 0
  for (let index = 0; index < 4; index++) {
    const a = points[index],
      b = points[(index + 1) % 4],
      c = points[(index + 2) % 4]
    if (!a || !b || !c) throw new Error("Missing content corner.")
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
    if (Math.abs(cross) < 1e-8 || (direction && Math.sign(cross) !== direction))
      unavailable()
    direction = Math.sign(cross)
  }
  const [p0, p1, p2, p3] = points
  if (!p0 || !p1 || !p2 || !p3) throw new Error("Missing content quad.")
  const dx1 = p1.x - p2.x,
    dx2 = p3.x - p2.x,
    dx3 = p0.x - p1.x + p2.x - p3.x,
    dy1 = p1.y - p2.y,
    dy2 = p3.y - p2.y,
    dy3 = p0.y - p1.y + p2.y - p3.y
  let g = 0,
    h = 0
  if (Math.abs(dx3) + Math.abs(dy3) > 1e-8) {
    const det = dx1 * dy2 - dx2 * dy1
    if (Math.abs(det) < 1e-12) unavailable()
    g = (dx3 * dy2 - dx2 * dy3) / det
    h = (dx1 * dy3 - dx3 * dy1) / det
  }
  return [
    (p1.x - p0.x + g * p1.x) / width,
    (p3.x - p0.x + h * p3.x) / height,
    p0.x,
    (p1.y - p0.y + g * p1.y) / width,
    (p3.y - p0.y + h * p3.y) / height,
    p0.y,
    g / width,
    h / height,
    1,
  ]
}

// Fixed code runs only in the target's isolated world, never from model input.
// Both leaf controls and each iframe owner need the same shadow/occlusion test.
export const browserPointerGeometry = `function(scroll, point) {
  if (!(this instanceof Element) || !this.isConnected || this.ownerDocument !== document || Element.prototype.matches.call(this, ':disabled')) return {ok:false};
  if (scroll) Element.prototype.scrollIntoView.call(this, {block:'center',inline:'center',behavior:'instant'});
  const doc=this.ownerDocument, root=this.getRootNode();
  let outer=this, outerRoot=root;
  while (outerRoot instanceof ShadowRoot) { outer=outerRoot.host; outerRoot=outer.getRootNode(); }
  const hits=(x,y)=>{
    const globalHit=Document.prototype.elementFromPoint.call(doc,x,y);
    if (root instanceof ShadowRoot && globalHit !== outer) return false;
    let hit=root instanceof ShadowRoot ? root.elementFromPoint(x,y) : globalHit;
    while (hit) {
      if (Node.prototype.contains.call(this,hit)) return true;
      const hitRoot=hit.getRootNode(); hit=hitRoot instanceof ShadowRoot ? hitRoot.host : null;
    }
    return false;
  };
  if (point) return {ok:hits(point.x,point.y),x:point.x,y:point.y};
  const rects=Element.prototype.getClientRects.call(this), view=doc.defaultView;
  // This bounds geometry work for long inline content, not page contents.
  for(let i=0;i<Math.min(rects.length,16);i++) {
    const rect=rects[i], left=Math.max(0,rect.left),top=Math.max(0,rect.top),right=Math.min(view.innerWidth,rect.right),bottom=Math.min(view.innerHeight,rect.bottom);
    if(right<=left || bottom<=top)continue;
    const x=(left+right)/2,y=(top+bottom)/2;
    if(hits(x,y))return {ok:true,x,y};
  }
  return {ok:false};
}`

export class BrowserFramePointer {
  readonly #path: BrowserFrameBinding[]
  readonly #command: BrowserReadCommand
  readonly #group: string
  readonly sessions = new Set<string | undefined>()
  #worlds = new Map<string, number>()
  #owners: {
    parent: BrowserFrameBinding
    child: BrowserFrameBinding
    backendNodeId: number
    objectId: string
  }[] = []

  constructor(
    path: BrowserFrameBinding[],
    command: BrowserReadCommand,
    group: string,
  ) {
    this.#path = path
    this.#command = command
    this.#group = group
  }

  verifyPath(path: BrowserFrameBinding[]): void {
    if (
      path.length !== this.#path.length ||
      path.some((frame, index) => {
        const prior = this.#path[index]
        return (
          !prior ||
          frame.sessionId !== prior.sessionId ||
          frame.document.frameId !== prior.document.frameId ||
          frame.document.documentId !== prior.document.documentId ||
          frame.document.url !== prior.document.url
        )
      })
    )
      throw new BrowserControlError(
        "browser_frame_stale",
        "A parent frame changed during pointer input. List frames again.",
      )
  }

  async prepare(): Promise<void> {
    for (const frame of this.#path) {
      const world = record(
        await this.#command(
          "Page.createIsolatedWorld",
          {
            frameId: frame.document.frameId,
            worldName: "yakitori-browser-input",
          },
          frame.sessionId,
        ),
      )
      if (typeof world.executionContextId !== "number")
        throw new Error("Missing pointer world.")
      this.#worlds.set(frame.document.frameId, world.executionContextId)
    }
    for (let index = 1; index < this.#path.length; index++) {
      const parent = this.#path[index - 1],
        child = this.#path[index]
      if (!parent || !child) throw new Error("Missing frame ancestry.")
      const owner = record(
        await this.#command(
          "DOM.getFrameOwner",
          { frameId: child.document.frameId },
          parent.sessionId,
        ),
      )
      if (typeof owner.backendNodeId !== "number")
        throw new Error("Missing frame owner.")
      this.sessions.add(parent.sessionId)
      const resolved = record(
        record(
          await this.#command(
            "DOM.resolveNode",
            {
              backendNodeId: owner.backendNodeId,
              executionContextId: this.#worlds.get(parent.document.frameId),
              objectGroup: this.#group,
            },
            parent.sessionId,
          ),
        ).object,
      )
      if (typeof resolved.objectId !== "string") unavailable()
      this.#owners.push({
        parent,
        child,
        backendNodeId: owner.backendNodeId,
        objectId: resolved.objectId,
      })
      await this.#command(
        "Runtime.callFunctionOn",
        {
          objectId: resolved.objectId,
          returnByValue: true,
          functionDeclaration: browserPointerGeometry,
          arguments: [{ value: true }, { value: null }],
        },
        parent.sessionId,
      )
    }
  }

  async project(point: BrowserPoint): Promise<BrowserPoint> {
    const root = this.#path[0]
    if (!root) throw new Error("Missing root frame.")
    const transforms = new Map<string, Matrix>([
      [root.document.frameId, identity],
    ])
    for (const { parent, child, backendNodeId } of this.#owners) {
      const sessionRoot = this.#path.find(
        (frame) => frame.sessionId === parent.sessionId,
      )
      const parentTransform =
        sessionRoot && transforms.get(sessionRoot.document.frameId)
      if (!parentTransform)
        throw new Error("Missing parent session projection.")
      const box = record(
        record(
          await this.#command(
            "DOM.getBoxModel",
            { backendNodeId },
            parent.sessionId,
          ),
        ).model,
      )
      const viewport = record(
        record(
          record(
            await this.#command(
              "Runtime.evaluate",
              {
                expression: "({width:innerWidth,height:innerHeight})",
                contextId: this.#worlds.get(child.document.frameId),
                returnByValue: true,
              },
              child.sessionId,
            ),
          ).result,
        ).value,
      )
      transforms.set(
        child.document.frameId,
        multiply(
          parentTransform,
          contentProjection(box.content, viewport.width, viewport.height),
        ),
      )
    }
    const leaf = this.#path.at(-1),
      leafTransform = leaf && transforms.get(leaf.document.frameId)
    if (!leafTransform) throw new Error("Missing leaf projection.")
    const mainPoint = mapPoint(leafTransform, point)
    for (const { parent, objectId } of this.#owners) {
      const transform = transforms.get(parent.document.frameId)
      if (!transform) throw new Error("Missing ancestor projection.")
      const localPoint = mapPoint(inverse(transform), mainPoint)
      const hit = record(
        record(
          await this.#command(
            "Runtime.callFunctionOn",
            {
              objectId,
              returnByValue: true,
              functionDeclaration: browserPointerGeometry,
              arguments: [{ value: false }, { value: localPoint }],
            },
            parent.sessionId,
          ),
        ).result,
      )
      if (record(hit.value).ok !== true) unavailable()
    }
    return mainPoint
  }
}
