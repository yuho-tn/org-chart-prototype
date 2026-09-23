import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, X } from "lucide-react";

export type LightboxImage = {
  src: string;
  alt: string;
  caption?: string;
};

type ImageLightboxProps = {
  images: LightboxImage[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
};

export function ImageLightbox({ images, index, onIndexChange, onClose }: ImageLightboxProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const image = images[index];
  const hasMultiple = images.length > 1;

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowLeft" && images.length > 1) {
        onIndexChange((index - 1 + images.length) % images.length);
      }
      if (event.key === "ArrowRight" && images.length > 1) {
        onIndexChange((index + 1) % images.length);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [images.length, index, onClose, onIndexChange]);

  if (!image) return null;

  return createPortal(
    <div
      className="imageLightbox"
      role="dialog"
      aria-modal="true"
      aria-label="画像を拡大表示"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <button
        ref={closeRef}
        type="button"
        className="imageLightbox__close"
        onClick={onClose}
        aria-label="拡大表示を閉じる"
      >
        <X size={22} aria-hidden="true" />
      </button>

      {hasMultiple ? (
        <button
          type="button"
          className="imageLightbox__nav imageLightbox__nav--prev"
          onClick={() => onIndexChange((index - 1 + images.length) % images.length)}
          aria-label="前の画像"
        >
          <ChevronLeft size={28} aria-hidden="true" />
        </button>
      ) : null}

      <figure className="imageLightbox__figure">
        <img className="imageLightbox__image" src={image.src} alt={image.alt} />
        {image.caption ? (
          <figcaption className="imageLightbox__caption">{image.caption}</figcaption>
        ) : null}
      </figure>

      {hasMultiple ? (
        <button
          type="button"
          className="imageLightbox__nav imageLightbox__nav--next"
          onClick={() => onIndexChange((index + 1) % images.length)}
          aria-label="次の画像"
        >
          <ChevronRight size={28} aria-hidden="true" />
        </button>
      ) : null}

      {hasMultiple ? (
        <span className="imageLightbox__count" aria-live="polite">
          {index + 1} / {images.length}
        </span>
      ) : null}
    </div>,
    document.body,
  );
}
