import { useEffect, useRef, type ReactNode } from 'react';

export function Dialog({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const requestClose = () => {
    if (dialog.current?.querySelector('fieldset:disabled')) return;
    close();
  };
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="modal native-dialog"
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
      onClick={(event) => {
        if (event.target === dialog.current) requestClose();
      }}
      aria-label={title}
    >
      <header>
        <h2>{title}</h2>
        <button aria-label="关闭对话框" onClick={requestClose}>
          ×
        </button>
      </header>
      {children}
    </dialog>
  );
}
