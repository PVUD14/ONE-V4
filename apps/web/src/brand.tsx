/**
 * The standard AI8HT wordmark, sliced from the master logo into three
 * transparent PNGs (AI / 8 / HT) so the 8 can spin in place. The source art is
 * silver on black; a CSS invert renders it dark on the app's light surfaces.
 */
export function BrandWordmark({ height = 30, className }: {
  readonly height?: number;
  readonly className?: string;
}): React.ReactElement {
  return <span className={`brand-wordmark${className ? ` ${className}` : ''}`} role="img" aria-label="AI8HT" style={{ height }}>
    <img src="/assets/ai8ht-left.png" alt="" draggable={false} />
    <img className="brand-eight" src="/assets/ai8ht-eight.png" alt="" draggable={false} />
    <img src="/assets/ai8ht-right.png" alt="" draggable={false} />
  </span>;
}
