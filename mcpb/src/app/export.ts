import type { BasePayload, ViewResult } from "./shell.js";
import { esc } from "./theme.js";

/** A portable figure includes the context otherwise drawn outside its SVGs. */
export function chartSvg(root: HTMLElement, result: ViewResult, payload: BasePayload): string {
  const theme = document.documentElement.getAttribute("data-theme") ?? "light";
  const styles = document.querySelector("style")?.textContent ?? "";
  const svgs = Array.from(root.querySelectorAll(".chart svg"));
  const dimensions = svgs.map((svg) => {
    const [, , width = 900, height = 300] = (svg.getAttribute("viewBox") ?? "0 0 900 300")
      .split(/\s+/).map(Number);
    return { width, height };
  });
  const width = Math.max(900, ...dimensions.map((d) => d.width + 40));
  const parts: string[] = [];
  let y = 28;
  const text = (value: string, size = 13, color = "var(--fg)", x = 20): void => {
    const maxChars = Math.max(30, Math.floor((width - x - 30) / (size * 0.58)));
    const words = value.trim().split(/\s+/);
    let line = "";
    const draw = (): void => {
      parts.push(`<text x="${x}" y="${y}" fill="${color}" font-size="${size}">${esc(line)}</text>`);
      y += size + 6;
    };
    for (const word of words) {
      if (line && line.length + word.length + 1 > maxChars) {
        draw();
        line = "";
      }
      line += `${line ? " " : ""}${word}`;
    }
    if (line) draw();
  };

  text(result.title, 20);
  const subtitle = root.querySelector(".totals")?.textContent;
  if (subtitle) text(subtitle);
  const scope = Array.from(root.querySelectorAll(".chip")).map((chip) => chip.textContent).join(" · ");
  if (scope) text(`Selection: ${scope}`, 12);
  svgs.forEach((svg, i) => {
    y += 18;
    const panel = svg.closest(".panel");
    const caption = panel?.querySelector("h2")?.textContent || svg.getAttribute("aria-label");
    if (caption) text(caption, 14);
    const d = dimensions[i];
    parts.push(`<svg x="20" y="${y}" width="${d.width}" height="${d.height}" style="width:${d.width}px;height:${d.height}px" viewBox="0 0 ${d.width} ${d.height}">${svg.innerHTML}</svg>`);
    y += d.height + 8;
    const legend = svg.nextElementSibling?.matches(".legend") ? svg.nextElementSibling : panel?.querySelector(".legend");
    for (const item of Array.from(legend?.querySelectorAll("li") ?? [])) {
      const swatch = item.querySelector<HTMLElement>(".swatch");
      const color = swatch?.style.backgroundColor || swatch?.style.background || "var(--fg)";
      parts.push(`<rect x="20" y="${y - 10}" width="10" height="10" rx="2" fill="${esc(color)}"/>`);
      text(item.textContent ?? "", 12, "var(--fg)", 38);
    }
  });
  y += 18;
  for (const note of result.notes ?? []) if (typeof note === "string" && note) text(note, 12, "var(--muted)");
  const provenance = payload.provenance as { snapshot_id?: string } | undefined;
  if (provenance?.snapshot_id) text(`Dataset snapshot: ${provenance.snapshot_id}`, 11, "var(--muted)");
  text(`Exported ${new Date().toISOString()}`, 11, "var(--muted)");
  y += 12;
  return `<svg xmlns="http://www.w3.org/2000/svg" data-theme="${theme}" viewBox="0 0 ${width} ${y}" width="${width}" height="${y}" style="font-family:system-ui,sans-serif"><style>${esc(styles)}</style><rect width="100%" height="100%" fill="${theme === "dark" ? "#17130f" : "#ffffff"}"/><title>${esc(result.title)}</title>${parts.join("")}</svg>`;
}
