import type { SVGProps } from "react";

export type IconName =
  | "pin"
  | "alert"
  | "order"
  | "check"
  | "temple"
  | "user"
  | "bot"
  | "close"
  | "arrow"
  | "database"
  | "cube"
  | "wave"
  | "book"
  | "sliders"
  | "pause"
  | "play"
  | "save"
  | "route"
  | "send"
  | "layers";

const paths: Record<IconName, React.ReactNode> = {
  pin: <><path d="M12 21s6-5.2 6-11a6 6 0 1 0-12 0c0 5.8 6 11 6 11Z"/><circle cx="12" cy="10" r="2.1"/></>,
  alert: <><path d="M12 3 2.8 19h18.4L12 3Z"/><path d="M12 9v4"/><path d="M12 16.4h.01"/></>,
  order: <><rect x="5" y="4" width="14" height="17" rx="1.5"/><path d="M9 4.5V3h6v1.5M8.5 9h7M8.5 13h7M8.5 17h4"/></>,
  check: <><rect x="4" y="5" width="16" height="16" rx="2"/><path d="M8 4V2m8 2V2M7.5 13l3 3 6-7"/></>,
  temple: <><path d="M3 9h18L12 3 3 9Zm2 1v9m4-9v9m6-9v9m4-9v9M2 21h20"/></>,
  user: <><circle cx="12" cy="8" r="4"/><path d="M4.5 21a7.5 7.5 0 0 1 15 0"/></>,
  bot: <><rect x="4" y="6" width="16" height="14" rx="3"/><path d="M12 2v4M8 11h.01M16 11h.01M8 16h8"/></>,
  close: <><path d="m6 6 12 12M18 6 6 18"/></>,
  arrow: <><path d="M5 12h14M14 7l5 5-5 5"/></>,
  database: <><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></>,
  cube: <><path d="M12 2.6 21 7v10l-9 4.4L3 17V7l9-4.4Z"/><path d="M3 7l9 4.4L21 7M12 11.4V21.4"/></>,
  wave: <><path d="M2 14c3-8 5 8 8 0s5 6 8-2 4 4 4 4"/><path d="M2 20h20"/></>,
  book: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5Z"/><path d="M4 5.5V20.5M8 7h8M8 11h6"/></>,
  sliders: <><path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h9M17 17h3"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="15" cy="17" r="2"/></>,
  pause: <><rect x="7" y="5" width="3.4" height="14"/><rect x="13.6" y="5" width="3.4" height="14"/></>,
  play: <><path d="M7 4.5 19 12 7 19.5Z"/></>,
  save: <><path d="M5 3h11l3 3v15H5Z"/><path d="M8 3v6h8V3M8 15h8"/></>,
  route: <><circle cx="5" cy="6" r="2"/><circle cx="19" cy="18" r="2"/><path d="M7 6h6a4 4 0 0 1 0 8H9a3 3 0 0 0 0 6h8"/></>,
  send: <><path d="M4 12 20 4l-6 16-3-7Z"/></>,
  layers: <><path d="M12 3 3 8l9 5 9-5-9-5Z"/><path d="M3 13l9 5 9-5"/></>,
};

export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: IconName }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name]}</svg>;
}
