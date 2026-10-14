// Tests for <StatusTag>: the approved stage and verification colours, and the slanted tag markup.
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusTag, statusTone } from './statusTag.js';

describe('statusTone', () => {
  it('colours application stages as approved: early stages brand, Interview cyan, Offer orange, Hired green, the rest neutral', () => {
    for (const stage of ['APPLIED', 'SCREENING', 'SHORTLISTED', 'ASSESSMENT']) expect(statusTone(stage, 'application')).toBe('band');
    expect(statusTone('INTERVIEW', 'application')).toBe('cyan');
    expect(statusTone('OFFER', 'application')).toBe('hot');
    expect(statusTone('HIRED', 'application')).toBe('ok');
    expect(statusTone('WITHDRAWN', 'application')).toBe('mute');
    expect(statusTone('REJECTED', 'application')).toBe('mute');
    expect(statusTone('NOT_SELECTED', 'application')).toBe('mute');
  });

  it('colours verification states per the component sheet', () => {
    expect(statusTone('VERIFIED', 'verification')).toBe('ok');
    expect(statusTone('PENDING', 'verification')).toBe('warn');
    expect(statusTone('UNDER_REVIEW', 'verification')).toBe('warn');
    expect(statusTone('CHANGES_REQUESTED', 'verification')).toBe('hot');
    expect(statusTone('REJECTED', 'verification')).toBe('danger');
    expect(statusTone('EXPIRED', 'verification')).toBe('mute');
    expect(statusTone('SELF_REPORTED', 'verification')).toBe('line');
  });

  it('treats an unknown code as neutral and ignores case and spacing', () => {
    expect(statusTone('SOMETHING_NEW', 'application')).toBe('mute');
    expect(statusTone('interview', 'application')).toBe('cyan');
    expect(statusTone('Not selected', 'application')).toBe('mute');
  });
});

describe('<StatusTag>', () => {
  it('renders the label upright inside a slanted tag with the tone and the older state classes', () => {
    render(<StatusTag kind="application" state="INTERVIEW" label="Interview" />);
    const tag = screen.getByText('Interview');
    expect(tag).toHaveClass('tag', 't-cyan', 'hiring-state', 'state-interview');
    expect(tag).toHaveAttribute('data-tone', 'cyan');
  });

  it('sentence-cases the code when no label is given and marks Hired with a check', () => {
    const { container } = render(<StatusTag kind="application" state="HIRED" />);
    expect(screen.getByText('Hired')).toHaveClass('t-ok');
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('always reads a REJECTED hiring stage as "Not selected", whatever label was passed', () => {
    render(<StatusTag kind="application" state="REJECTED" label="Rejected" />);
    expect(screen.getByText('Not selected')).toHaveClass('t-mute');
    expect(screen.queryByText('Rejected')).toBeNull();
  });

  it('draws the gold celebration variant when a view asks for it', () => {
    render(<StatusTag kind="application" state="OFFER" tone="gold" label="Offer" />);
    expect(screen.getByText('Offer')).toHaveClass('tag', 't-gold');
  });

  it('lets a screen with no approved mapping pass its tone', () => {
    render(<StatusTag kind="verification" state="CONFLICT" tone="danger" label="Conflicts" />);
    expect(screen.getByText('Conflicts')).toHaveClass('t-danger');
  });
});
