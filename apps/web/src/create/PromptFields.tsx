/**
 * Prompt, and the negative prompt hiding behind it.
 *
 * The artboard makes the hierarchy explicit: one large bordered textarea, and
 * beneath it a plain "+ Add a negative prompt" line with no box of its own.
 * Negative prompts matter to perhaps one user in five and cost the other four
 * a chunk of the panel, so it stays collapsed until asked for — and reopens
 * automatically whenever there is text in it (a remix, a reload) so that a
 * value can never be applied invisibly.
 */
import { useEffect, useRef } from 'react';
import { CloseIcon } from './icons';
import { PlusIcon } from '../components/icons';
import styles from './prompt.module.css';

export function PromptFields({
  prompt,
  negativePrompt,
  negativeOpen,
  onPromptChange,
  onNegativeChange,
  onNegativeOpenChange,
  onSubmit,
}: {
  prompt: string;
  negativePrompt: string;
  negativeOpen: boolean;
  onPromptChange: (value: string) => void;
  onNegativeChange: (value: string) => void;
  onNegativeOpenChange: (open: boolean) => void;
  /** Cmd/Ctrl+Enter from either field. */
  onSubmit: () => void;
}) {
  const negativeRef = useRef<HTMLTextAreaElement>(null);
  const wasOpen = useRef(negativeOpen);

  useEffect(() => {
    if (negativeOpen && !wasOpen.current) negativeRef.current?.focus();
    wasOpen.current = negativeOpen;
  }, [negativeOpen]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className={styles.group}>
      <div className="label" id="prompt-label">
        Prompt
      </div>
      <textarea
        className={styles.prompt}
        aria-labelledby="prompt-label"
        placeholder="a lone figure on a rain-slick street, neon signage, anamorphic bokeh"
        value={prompt}
        rows={4}
        onChange={(event) => onPromptChange(event.target.value)}
        onKeyDown={onKeyDown}
      />

      {negativeOpen ? (
        <div className={styles.negativeBlock}>
          <div className={styles.negativeHead}>
            <span className={styles.negativeLabel}>Negative</span>
            <button
              type="button"
              className={styles.negativeClose}
              onClick={() => {
                // Clearing on close is the honest move: a collapsed field that
                // still conditions the image is a control that lies.
                onNegativeChange('');
                onNegativeOpenChange(false);
              }}
              title="Remove the negative prompt"
              aria-label="Remove the negative prompt"
            >
              <CloseIcon size={11} />
            </button>
          </div>
          <textarea
            ref={negativeRef}
            className={styles.negative}
            aria-label="Negative prompt"
            placeholder="blurry, extra fingers, watermark"
            value={negativePrompt}
            rows={2}
            onChange={(event) => onNegativeChange(event.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
      ) : (
        <button type="button" className={styles.addNegative} onClick={() => onNegativeOpenChange(true)}>
          <PlusIcon size={13} />
          Add a negative prompt
        </button>
      )}
    </div>
  );
}
