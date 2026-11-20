import { createElement, type ComponentPropsWithoutRef, type SVGProps } from "react";

export type IconName = 'check' | 'check-circle' | 'x' | 'x-circle' | 'ban' | 'eye' | 'eye-off' | 'pencil' | 'circle' | 'key' | 'arrow' | 'sparkle' | 'doc' | 'download' | 'shield' | 'users' | 'library' | 'search' | 'book' | 'clipboard' | 'clock' | 'plus' | 'message' | 'reply' | 'nodes' | 'hash' | 'upload' | 'scale' | 'gift' | 'cc';

const ICONS: Record<string, { tag: string; attrs: Record<string, string> }[]> = {
  "check": [
    { tag: "path", attrs: {'d': 'M5 12.5l4.2 4.2L19 7'} },
  ],
  "check-circle": [
    { tag: "circle", attrs: {'cx': '12', 'cy': '12', 'r': '9'} },
    { tag: "path", attrs: {'d': 'M8.2 12.4l2.6 2.6 5-5.2'} },
  ],
  "x": [
    { tag: "path", attrs: {'d': 'M7 7l10 10M17 7L7 17'} },
  ],
  "x-circle": [
    { tag: "circle", attrs: {'cx': '12', 'cy': '12', 'r': '9'} },
    { tag: "path", attrs: {'d': 'M9 9l6 6M15 9l-6 6'} },
  ],
  "ban": [
    { tag: "circle", attrs: {'cx': '12', 'cy': '12', 'r': '8.5'} },
    { tag: "path", attrs: {'d': 'M6 6l12 12'} },
  ],
  "eye": [
    { tag: "path", attrs: {'d': 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z'} },
    { tag: "circle", attrs: {'cx': '12', 'cy': '12', 'r': '3'} },
  ],
  "eye-off": [
    { tag: "path", attrs: {'d': 'M3 3l18 18M10.6 5.6A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3 3.7M6.4 6.9A16.6 16.6 0 0 0 2.5 12S6 18.5 12 18.5a9 9 0 0 0 4.3-1.1'} },
    { tag: "path", attrs: {'d': 'M9.9 9.9a3 3 0 0 0 4.2 4.2'} },
  ],
  "pencil": [
    { tag: "path", attrs: {'d': 'M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4'} },
  ],
  "circle": [
    { tag: "circle", attrs: {'cx': '12', 'cy': '12', 'r': '7.5'} },
  ],
  "key": [
    { tag: "circle", attrs: {'cx': '7.5', 'cy': '15.5', 'r': '4'} },
    { tag: "path", attrs: {'d': 'M10.4 12.6L20 3M16.5 6.5L19 9M14 9l2 2'} },
  ],
  "arrow": [
    { tag: "path", attrs: {'d': 'M5 12h14M13 6l6 6-6 6'} },
  ],
  "sparkle": [
    { tag: "path", attrs: {'d': 'M11 3l1.9 5.6L18.5 10.5l-5.6 1.9L11 18l-1.9-5.6L3.5 10.5l5.6-1.9z'} },
    { tag: "path", attrs: {'d': 'M18.5 15.5l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7z'} },
  ],
  "doc": [
    { tag: "path", attrs: {'d': 'M6 3h8l4 4v14H6z'} },
    { tag: "path", attrs: {'d': 'M14 3v4h4M9 12h6M9 16h6'} },
  ],
  "download": [
    { tag: "path", attrs: {'d': 'M12 4v11M7 10l5 5 5-5M5 20h14'} },
  ],
  "shield": [
    { tag: "path", attrs: {'d': 'M12 3l7 3v6c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V6z'} },
    { tag: "path", attrs: {'d': 'M9 12l2.2 2.2L15.5 10'} },
  ],
  "users": [
    { tag: "circle", attrs: {'cx': '9', 'cy': '8', 'r': '3.3'} },
    { tag: "path", attrs: {'d': 'M3 20c0-3.3 2.7-5.6 6-5.6s6 2.3 6 5.6'} },
    { tag: "circle", attrs: {'cx': '17', 'cy': '9', 'r': '2.6'} },
    { tag: "path", attrs: {'d': 'M16.4 14.4c2.8 0 4.6 2 4.6 4.6'} },
  ],
  "library": [
    { tag: "path", attrs: {'d': 'M3 21h18M5 21v-9M9.7 21v-9M14.3 21v-9M19 21v-9M2.5 10L12 4l9.5 6z'} },
  ],
  "search": [
    { tag: "circle", attrs: {'cx': '11', 'cy': '11', 'r': '6.5'} },
    { tag: "path", attrs: {'d': 'M16 16l4.5 4.5'} },
  ],
  "book": [
    { tag: "path", attrs: {'d': 'M3 5.5c3-1.2 6-1 9 1 3-2 6-2.2 9-1V19c-3-1.2-6-1-9 1-3-2-6-2.2-9-1z'} },
    { tag: "path", attrs: {'d': 'M12 6.5V20'} },
  ],
  "clipboard": [
    { tag: "rect", attrs: {'x': '5', 'y': '4.5', 'width': '14', 'height': '16.5', 'rx': '2.2'} },
    { tag: "path", attrs: {'d': 'M9 4.5h6V7H9zM9 13.5l2 2 4-4.2'} },
  ],
  "clock": [
    { tag: "circle", attrs: {'cx': '12', 'cy': '12', 'r': '9'} },
    { tag: "path", attrs: {'d': 'M12 7v5l3.2 2'} },
  ],
  "plus": [
    { tag: "path", attrs: {'d': 'M12 5v14M5 12h14'} },
  ],
  "message": [
    { tag: "path", attrs: {'d': 'M4 5h16v11H9.5L5 20v-4H4z'} },
  ],
  "reply": [
    { tag: "path", attrs: {'d': 'M9.5 7L4.5 12l5 5'} },
    { tag: "path", attrs: {'d': 'M4.5 12H15a5 5 0 0 1 5 5v1.5'} },
  ],
  "nodes": [
    { tag: "circle", attrs: {'cx': '6', 'cy': '6.5', 'r': '2.5'} },
    { tag: "circle", attrs: {'cx': '18', 'cy': '6.5', 'r': '2.5'} },
    { tag: "circle", attrs: {'cx': '12', 'cy': '18', 'r': '2.5'} },
    { tag: "path", attrs: {'d': 'M8.5 6.5h7M7.2 8.7l3.6 7M16.8 8.7l-3.6 7'} },
  ],
  "hash": [
    { tag: "path", attrs: {'d': 'M5 9h14M5 15h14M10 4L8.5 20M15.5 4L14 20'} },
  ],
  "upload": [
    { tag: "path", attrs: {'d': 'M12 16V5M7 9.5l5-5 5 5M5 20h14'} },
  ],
  "scale": [
    { tag: "path", attrs: {'d': 'M12 4v16M7 20h10M5 8h14M5 8l-2.5 6a3 3 0 0 0 5 0zM19 8l-2.5 6a3 3 0 0 0 5 0z'} },
  ],
  "gift": [
    { tag: "path", attrs: {'d': 'M12 21V8M3.5 8h17v4h-17zM5 12h14v9H5z'} },
    { tag: "path", attrs: {'d': 'M12 8S10.5 3.5 7.8 4.6C6 5.4 7 8 9 8M12 8s1.5-4.5 4.2-3.4C18 5.4 17 8 15 8'} },
  ],
  "cc": [
    { tag: "circle", attrs: {'cx': '12', 'cy': '12', 'r': '9'} },
    { tag: "path", attrs: {'d': 'M10.5 10a2.5 2.5 0 1 0 0 4M16.5 10a2.5 2.5 0 1 0 0 4'} },
  ],
};


export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  name: IconName | string;
}

export function Icon({ name, className, ...rest }: IconProps) {
  const key = String(name);
  const parts = ICONS[key] ?? [];
  return createElement(
    "svg",
    {
      className: className ? `ico ${className}` : "ico",
      viewBox: "0 0 24 24",
      "aria-hidden": "true",
      focusable: "false",
      ...rest,
    },
    parts.map((part, index) =>
      createElement(part.tag, { key: index, ...part.attrs }),
    ),
  );
}

export default Icon;


export function CheckIcon(props: Omit<IconProps, "name"> = {}) {
  return createElement(Icon, { name: "check", ...props });
}


export function CheckCircleIcon(props: Omit<IconProps, "name"> = {}) {
  return createElement(Icon, { name: "check-circle", ...props });
}


export function XIcon(props: Omit<IconProps, "name"> = {}) {
  return createElement(Icon, { name: "x", ...props });
}


export function XCircleIcon(props: Omit<IconProps, "name"> = {}) {
  return createElement(Icon, { name: "x-circle", ...props });
}


export function BanIcon(props: Omit<IconProps, "name"> = {}) {
  return createElement(Icon, { name: "ban", ...props });
}


export function EyeIcon(props: Omit<IconProps, "name"> = {}) {
  return createElement(Icon, { name: "eye", ...props });
}


export function EyeOffIcon(props: Omit<IconProps, "name"> = {}) {
  return createElement(Icon, { name: "eye-off", ...props });
}


export function PencilIcon(props: Omit<IconProps, "name"> = {}) {
  return createElement(Icon, { name: "pencil", ...props });
}


export function CircleIcon(props: Omit<IconProps, "name"> = {}) {
  return createElement(Icon, { name: "circle", ...props });
}


export function KeyIcon(props: Omit<IconProps, "name"> = {}) {
  return createElement(Icon, { name: "key", ...props });
}


export function ArrowIcon(props: Omit<IconProps, "name"> = {}) {
  return createElement(Icon, { name: "arrow", ...props });
}


export function SparkleIcon(props: Omit<IconProps, "name"> = {}) {
  return createElement(Icon, { name: "sparkle", ...props });
}


export function DocIcon(props: Omit<IconProps, "name"> = {}) {
  return createElement(Icon, { name: "doc", ...props });
}


export function DownloadIcon(props: Omit<IconProps, "name"> = {}) {
  return createElement(Icon, { name: "download", ...props });
}


export function ShieldIcon(props: Omit<IconProps, "name"> = {}) {
  return createElement(Icon, { name: "shield", ...props });
}


export function UsersIcon(props: Omit<IconProps, "name"> = {}) {
  return createElement(Icon, { name: "users", ...props });
}


export function LibraryIcon(props: Omit<IconProps, "name"> = {}) {
  return createElement(Icon, { name: "library", ...props });
}


export function SearchIcon(props: Omit<IconProps, "name"> = {}) {
  return createElement(Icon, { name: "search", ...props });
}


export function BookIcon(props: Omit<IconProps, "name"> = {}) {
  return createElement(Icon, { name: "book", ...props });
}


export function ClipboardIcon(props: Omit<IconProps, "name"> = {}) {
  return createElement(Icon, { name: "clipboard", ...props });
}


export function ClockIcon(props: Omit<IconProps, "name"> = {}) {
  return createElement(Icon, { name: "clock", ...props });
}


export function PlusIcon(props: Omit<IconProps, "name"> = {}) {
  return createElement(Icon, { name: "plus", ...props });
}


export function MessageIcon(props: Omit<IconProps, "name"> = {}) {
  return createElement(Icon, { name: "message", ...props });
}


export function ReplyIcon(props: Omit<IconProps, "name"> = {}) {
  return createElement(Icon, { name: "reply", ...props });
}


export function NodesIcon(props: Omit<IconProps, "name"> = {}) {
  return createElement(Icon, { name: "nodes", ...props });
}


export function HashIcon(props: Omit<IconProps, "name"> = {}) {
  return createElement(Icon, { name: "hash", ...props });
}


export function UploadIcon(props: Omit<IconProps, "name"> = {}) {
  return createElement(Icon, { name: "upload", ...props });
}


export function ScaleIcon(props: Omit<IconProps, "name"> = {}) {
  return createElement(Icon, { name: "scale", ...props });
}


export function GiftIcon(props: Omit<IconProps, "name"> = {}) {
  return createElement(Icon, { name: "gift", ...props });
}


export function CcIcon(props: Omit<IconProps, "name"> = {}) {
  return createElement(Icon, { name: "cc", ...props });
}
