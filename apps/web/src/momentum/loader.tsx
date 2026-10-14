/**
 * <Loading>: the Momentum loader — three chevrons climbing the 12° slant (MOTION-NOTES "Loader",
 * 1.2s, 160ms offset) beside the loading line a screen already shows.
 *
 * It exists so every home says "loading" the same way, with the approved motion, instead of a bare
 * line of text. The chevrons are decoration (aria-hidden); the line is the status the screen reader
 * hears. Under reduced motion the chevrons stand still. Styles: styles/motion.css.
 */
import React from 'react';

export function Loading({ children, className }: { readonly children: React.ReactNode; readonly className?: string }): React.ReactElement {
  return <p role="status" className={`m-loading${className ? ` ${className}` : ''}`}>
    <span className="m-loader" aria-hidden="true"><i /><i /><i /></span>
    <span>{children}</span>
  </p>;
}
