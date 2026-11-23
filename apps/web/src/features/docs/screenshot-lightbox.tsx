"use client";

import { useEffect, useId, useRef } from "react";

import type { HandbookScreenshot } from "./handbook";

export type ScreenshotLightboxProps = {
  screenshot?: HandbookScreenshot;
  src?: string;
  alt?: string;
  width?: number;
  height?: number;
  caption?: string;
};

export function ScreenshotLightbox(props: ScreenshotLightboxProps) {
  const shot: HandbookScreenshot = (props.screenshot ?? {
    src: props.src ?? "",
    alt: props.alt ?? "",
    width: props.width ?? 0,
    height: props.height ?? 0,
    caption: props.caption ?? "",
    heading: "",
    source: "",
  }) as HandbookScreenshot;

  const { src, alt, width, height, caption } = shot;

  const dialogRef = useRef<HTMLDialogElement>(null);
  const linkRef = useRef<HTMLAnchorElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const captionId = useId();
  const previousOverflow = useRef({ html: "", body: "" });

  function lockScroll() {
    previousOverflow.current = {
      html: document.documentElement.style.overflow,
      body: document.body.style.overflow,
    };
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
  }

  function unlockScroll() {
    document.documentElement.style.overflow = previousOverflow.current.html;
    document.body.style.overflow = previousOverflow.current.body;
  }

  function closeDialog() {
    unlockScroll();
    const dialog = dialogRef.current;
    if (dialog) {
      try {
        if (typeof dialog.close === "function") dialog.close();
        else dialog.open = false;
      } catch {
        if (dialog) dialog.open = false;
      }
    }
    linkRef.current?.focus();
  }

  function handleClick(event: React.MouseEvent<HTMLAnchorElement>) {
    if (
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    lockScroll();
    const dialog = dialogRef.current;
    if (dialog && typeof dialog.showModal === "function") {
      dialog.showModal();
    } else if (dialog) {
      dialog.open = true;
    }
    closeRef.current?.focus();
  }

  function handleBackdropClick(event: React.MouseEvent<HTMLDialogElement>) {
    if (event.target === dialogRef.current) {
      closeDialog();
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDialogElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeDialog();
    }
  }

  function handleClose() {
    unlockScroll();
    linkRef.current?.focus();
  }

  useEffect(() => {
    return () => {
      unlockScroll();
    };
  }, []);

  return (
    <figure className="my-6">
      <a
        ref={linkRef}
        href={src}
        aria-label={`Open full-size image: ${alt}`}
        className="block w-fit max-w-full cursor-zoom-in overflow-hidden rounded-card border border-rule bg-surface"
        onClick={handleClick}
      >
        <img
          src={src}
          alt={alt}
          width={width}
          height={height}
          loading="lazy"
          decoding="async"
          className="block h-auto max-h-[40rem] w-auto max-w-full"
        />
      </a>
      <figcaption className="mt-2 max-w-measure font-sans text-meta text-ink-2">
        {caption}
      </figcaption>

      <dialog
        ref={dialogRef}
        aria-labelledby={captionId}
        className="screenshot-lightbox"
        onClick={handleBackdropClick}
        onKeyDown={handleKeyDown}
        onClose={handleClose}
      >
        <div className="flex flex-col items-center gap-3">
          {/* Sizing lives in docs.css (`dialog.screenshot-lightbox img`): the
              image is capped against the dialog's content box, not viewport
              units, so the overlay never scrolls sideways at 375px. */}
          <img src={src} alt={alt} className="block h-auto w-auto object-contain" />
          <p id={captionId} className="text-center font-sans text-meta text-ink-2">
            {caption}
          </p>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close image"
            onClick={closeDialog}
            style={{ minHeight: "44px", minWidth: "44px" }}
            className="min-h-[44px] min-w-[44px] rounded-control border border-rule bg-surface px-3 py-2 font-sans text-ui text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            Close
          </button>
        </div>
      </dialog>
    </figure>
  );
}

export default ScreenshotLightbox;
