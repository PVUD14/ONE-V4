/**
 * The one icon component for the web app: the approved Momentum set, rendered inline.
 *
 * It replaces Lucide. Icons are solid two-tone glyphs coloured with currentColor; the active
 * state (the current nav item) fills them with the Momentum gradient and raises the second
 * tone. An icon is decorative (aria-hidden) unless it is given a label, in which case it is
 * announced as an image with that name. Icon-only buttons still need their own accessible name.
 */
import React, { useId } from 'react';
import { iconData, type IconName, type IconNode } from './iconData.js';

export { iconNames, utilityIconNames, type IconName } from './iconData.js';

export type IconSize = 16 | 20 | 24;

export interface IconProps {
  readonly name: IconName;
  /** 16 or 20 inline with text and in controls, 20 in the rail, 24 in card headers. */
  readonly size?: IconSize | undefined;
  /** The current item: gradient fill and the 55% second tone. */
  readonly active?: boolean | undefined;
  /** Plays the icon's micro-animation once when its `.one-icon-host` ancestor is hovered,
   * focused or becomes current. Nav and module tiles only, never utility icons in lists. */
  readonly animated?: boolean | undefined;
  /** Announces the icon as an image with this name; without it the icon is hidden from AT. */
  readonly label?: string | undefined;
  readonly className?: string | undefined;
  readonly style?: React.CSSProperties | undefined;
}

const gradientStops = [['0', '#2B1BB8'], ['.55', '#1E6BFF'], ['1', '#18C8E8']] as const;

function localise(value: string, prefix: string): string {
  return value.replace(/url\(#([^)]+)\)/g, (_, id: string) => `url(#${prefix}${id})`);
}

function renderNodes(nodes: readonly IconNode[], prefix: string): React.ReactNode[] {
  return nodes.map(([tag, attrs, children], index) => {
    const props: Record<string, string | number> = { key: index };
    for (const [key, value] of Object.entries(attrs)) {
      props[key] = key === 'id' ? `${prefix}${value}` : localise(value, prefix);
    }
    return React.createElement(tag, props, children ? renderNodes(children, prefix) : undefined);
  });
}

export function Icon({ name, size = 20, active = false, animated = false, label, className, style }: IconProps): React.ReactElement {
  // useId gives each rendered icon its own prefix for mask and gradient ids.
  const prefix = `oi${useId().replace(/[^a-zA-Z0-9_-]/g, '')}-`;
  const gradientId = `${prefix}mgrad`;
  const classes = ['one-icon', `ai-${name}`, active ? 'is-active' : '', animated ? 'one-icon--motion' : '', className ?? ''].filter(Boolean).join(' ');
  const a11y = label
    ? { role: 'img', 'aria-label': label }
    : { 'aria-hidden': true as const, focusable: 'false' as const };
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size}
      className={classes} style={style} fill={active ? `url(#${gradientId})` : 'currentColor'}
      data-icon={name} {...a11y}>
      {active ? (
        <defs>
          <linearGradient id={gradientId} gradientUnits="userSpaceOnUse" x1="3" y1="21" x2="21" y2="3">
            {gradientStops.map(([offset, color]) => <stop key={offset} offset={offset} stopColor={color} />)}
          </linearGradient>
        </defs>
      ) : null}
      {renderNodes(iconData[name], prefix)}
    </svg>
  );
}
