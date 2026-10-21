/**
 * Who can see an asset, in the words the Create panel and the Library share.
 *
 * One table so the two screens cannot drift: a picture saved as "Link only"
 * from Create must be called "Link only" on its tile.
 */
import type { Visibility } from '@comfy/shared';

export const VISIBILITIES: readonly Visibility[] = ['private', 'link', 'public'];

export const VISIBILITY_LABEL: Record<Visibility, string> = {
  private: 'Private',
  link: 'Link only',
  public: 'Public',
};

export const VISIBILITY_HINT: Record<Visibility, string> = {
  private: 'Only you can see it.',
  link: 'Anyone with the link can see it. It is never listed.',
  public: 'Anyone can see it.',
};

/** An absolute share URL for the clipboard; the API hands back a path. */
export function absoluteShareUrl(path: string): string {
  return new URL(path, window.location.origin).toString();
}
