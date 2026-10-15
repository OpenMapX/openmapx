"use client";

import dynamic from "next/dynamic";
import { type RefObject, useState } from "react";

import { SAVED_IMPORT_ACCEPT } from "@/lib/savedPlacesImport/types";

const ImportPlacesDialog = dynamic(
  () => import("./ImportPlacesDialog").then((module) => module.ImportPlacesDialog),
  { ssr: false },
);

export function ImportPlacesPicker({
  inputRef,
  targetListId,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  targetListId?: string;
}) {
  const [files, setFiles] = useState<File[] | null>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        hidden
        multiple
        accept={SAVED_IMPORT_ACCEPT}
        onChange={(event) => {
          const selected = Array.from(event.target.files || []);
          event.target.value = "";
          if (selected.length) setFiles(selected);
        }}
      />
      {files && (
        <ImportPlacesDialog
          files={files}
          targetListId={targetListId}
          onClose={() => setFiles(null)}
        />
      )}
    </>
  );
}
