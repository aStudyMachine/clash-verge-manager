import { useEffect, useRef, type ReactNode } from 'react';

export function Dialog({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  return <dialog ref={dialog} className="modal native-dialog" onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === dialog.current) close(); }} aria-label={title}>
    <header><h2>{title}</h2><button aria-label="关闭对话框" onClick={close}>×</button></header>{children}
  </dialog>;
}

