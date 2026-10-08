import { alertDialog } from "./components/Dialogs";
import { useSettings } from "./settings";
import { S } from "./strings";

/** Downscale an image file to a 64px square (cover-cropped) PNG data URL, so settings stay small. */
export async function iconDataUrl(file: File): Promise<string> {
  // <img> decodes anything the webview can display (SVG, ICO, HEIC); createImageBitmap rejects several of those.
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const size = 64;
    const iw = img.naturalWidth || size;
    const ih = img.naturalHeight || size;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const scale = Math.max(size / iw, size / ih);
    const w = iw * scale;
    const h = ih * scale;
    canvas.getContext("2d")!.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Let the user pick an image file and set it as `context`'s icon. */
export function pickClusterIcon(context: string) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      await useSettings.getState().updateCluster(context, { icon: await iconDataUrl(file) });
    } catch (err) {
      console.error("icon decode failed", file.type, err);
      alertDialog(
        S.cluster.iconReadFailed,
        S.cluster.iconReadFailedDetail(file.name, file.type, file.size, String(err)),
      );
    }
  };
  input.click();
}
