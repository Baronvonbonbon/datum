import { formatDOT } from "@shared/dot";
import { useSettings } from "../context/SettingsContext";
import { getCurrencySymbol } from "@shared/networks";

interface Props {
  planck: bigint | string;
  showSymbol?: boolean;
  style?: React.CSSProperties;
}

export function DOTAmount({ planck, showSymbol = true, style }: Props) {
  const { settings } = useSettings();
  const sym = getCurrencySymbol(settings.network);
  const value = typeof planck === "string" ? BigInt(planck) : planck;
  const formatted = formatDOT(value);

  return (
    <span style={style}>
      {formatted}{showSymbol ? ` ${sym}` : ""}
    </span>
  );
}
