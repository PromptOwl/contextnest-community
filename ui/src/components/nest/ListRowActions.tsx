import type { ReactNode } from "react";

/**
 * A Documents list row's actions, rendered once (po-1213).
 *
 * A phone has no hover, so its row gets the ⋮ menu (with the pin beside it);
 * a wider screen gets the hover buttons. Only one of the two is mounted: both
 * carry a pin control, and hiding one with CSS left two "Pin this document"
 * buttons in every row.
 */
export function ListRowActions({
  phone,
  menu,
  inline,
}: {
  phone: boolean;
  menu: ReactNode;
  inline: ReactNode;
}) {
  if (phone) return <div className="shrink-0">{menu}</div>;
  return (
    <div
      className="flex items-center gap-1 transition-opacity opacity-0 group-hover:opacity-100"
      onClick={(e) => e.stopPropagation()}
    >
      {inline}
    </div>
  );
}
