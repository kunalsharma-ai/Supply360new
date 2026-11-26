/**
 * A decorative 3D scene made only of CSS transforms: a spinning gem cube, an orbit ring and floating shapes.
 * No WebGL, no extra download; it is hidden from assistive tech and freezes when motion is off.
 */
const FACES = [
  'rotateY(0deg)',
  'rotateY(90deg)',
  'rotateY(180deg)',
  'rotateY(-90deg)',
  'rotateX(90deg)',
  'rotateX(-90deg)',
];
const FACE_FILL = [
  'linear-gradient(135deg,#a78bfa,#7c3aed)',
  'linear-gradient(135deg,#f9a8d4,#db2777)',
  'linear-gradient(135deg,#7dd3fc,#2563eb)',
  'linear-gradient(135deg,#6ee7b7,#059669)',
  'linear-gradient(135deg,#fde68a,#f59e0b)',
  'linear-gradient(135deg,#fdba74,#ea580c)',
];

export function HeroScene() {
  const s = 92;
  return (
    <div aria-hidden className="pointer-events-none relative h-56 w-full select-none [perspective:900px] md:h-64">
      {/* orbit ring */}
      <div className="absolute top-1/2 left-1/2 size-56 -translate-x-1/2 -translate-y-1/2 [transform-style:preserve-3d] md:size-64">
        <div className="fun-spin size-full rounded-full border-[6px] border-dashed border-fuchsia-400/50 [transform:rotateX(68deg)]" />
      </div>
      {/* cube */}
      <div className="absolute top-1/2 left-1/2" style={{ transform: `translate(-${s / 2}px,-${s / 2}px)` }}>
        <div className="fun-cube relative" style={{ width: s, height: s }}>
          {FACES.map((f, i) => (
            <div
              key={f}
              className="absolute inset-0 rounded-2xl border-2 border-white/60 shadow-[inset_0_0_24px_rgb(255_255_255/0.45)]"
              style={{ transform: `${f} translateZ(${s / 2}px)`, background: FACE_FILL[i] }}
            />
          ))}
        </div>
      </div>
      {/* floating bits */}
      <span
        className="fun-float absolute top-4 left-[12%] size-10 rounded-full bg-[radial-gradient(circle_at_30%_30%,#fff,#fbbf24_45%,#f97316)] shadow-lg"
        style={{ ['--d' as string]: '0ms' }}
      />
      <span
        className="fun-float absolute right-[10%] bottom-6 size-14 rounded-full bg-[radial-gradient(circle_at_30%_30%,#fff,#38bdf8_45%,#6366f1)] shadow-lg"
        style={{ ['--d' as string]: '-2s' }}
      />
      <span
        className="fun-float absolute top-8 right-[18%] size-8 rotate-12 rounded-lg bg-[linear-gradient(135deg,#86efac,#10b981)] shadow-lg"
        style={{ ['--d' as string]: '-4s' }}
      />
      <span
        className="fun-float absolute bottom-4 left-[20%] size-9 rounded-full border-[7px] border-pink-400 shadow-lg"
        style={{ ['--d' as string]: '-1s' }}
      />
      <svg
        className="fun-float absolute top-1/3 left-[4%] size-7 text-yellow-400 drop-shadow"
        viewBox="0 0 24 24"
        style={{ ['--d' as string]: '-3s' }}
      >
        <path fill="currentColor" d="m12 2 2.9 6.6 7.1.6-5.4 4.7 1.6 7L12 17.2 5.8 21l1.6-7L2 9.2l7.1-.6z" />
      </svg>
    </div>
  );
}
