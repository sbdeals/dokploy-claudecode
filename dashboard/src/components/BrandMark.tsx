/**
 * The Switchyard mark: a rail switch — one track running through, a second
 * branching off it. Inline SVG on `currentColor` so it takes the brand colour
 * from its wrapper and stays crisp at any size (login tile: 24px inside 44px).
 *
 * Decorative by itself (`aria-hidden`); give the wrapper `role="img"` and an
 * `aria-label` where the mark stands alone.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {/* through track */}
      <path d="M7 4v16" />
      {/* diverging track, leaving the switch point at (7,13) */}
      <path d="M7 13c0-5 10-4 10-9" />
      {/* ties */}
      <path d="M4.5 8h5M4.5 18h5" />
      {/* head of the branch */}
      <circle cx="17" cy="4" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}
