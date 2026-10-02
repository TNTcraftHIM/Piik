/** A user-requested download; release the temporary URL after browser dispatch. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
  } finally { setTimeout(() => URL.revokeObjectURL(url), 0); }
}
