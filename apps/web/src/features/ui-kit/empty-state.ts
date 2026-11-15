/**
 * EmptyState: one sentence and one action (docs/design.md §7).
 *
 * ```tsx
 * <EmptyState
 *   sentence="No reviews yet — qualified in cs.AI? Review this paper."
 *   action={{ label: "Review this paper", href: "/papers/123/review" }}
 * />
 * ```
 *
 * The rule is the point of the component, so the markup has no room for a
 * second sentence or a second button: exactly one `<p>` of text and exactly
 * one interactive element. A caller who needs more than that needs a
 * different component, not a bigger empty state.
 *
 * An empty state is not a live region and carries no `role`: it is ordinary
 * content that happens to say there is nothing here yet. The action is a link
 * when given an `href` and a button when given an `onClick`, so the element
 * matches what it does (navigation vs. a command).
 *
 * Server-safe (no hooks, no state). Plain `.ts` with `createElement` rather
 * than JSX because vitest cannot transform JSX in this app (tsconfig sets
 * `jsx: "preserve"`), and this keeps the real markup under test.
 */

import {
  createElement,
  type ComponentPropsWithoutRef,
  type MouseEventHandler,
  type ReactElement,
} from "react";

import { Icon, type IconName } from "./icons";
import "./empty-state.css";

/** The single action an empty state may offer. */
export interface EmptyStateAction {
  /** The action's accessible name; the only other words on screen. */
  label: string;
  /** Where the action goes. When set, the action renders as a link. */
  href?: string;
  /** What the action does. Used when `href` is absent. */
  onClick?: MouseEventHandler<HTMLElement>;
  /** Disable a button action. An `href` action ignores this. */
  disabled?: boolean;
}

export interface EmptyStateProps
  extends Omit<ComponentPropsWithoutRef<"div">, "children"> {
  /** The one sentence: what is missing, phrased as a live invitation. */
  sentence: string;
  /** The one action. */
  action: EmptyStateAction;
  /** Optional decorative icon. It is `aria-hidden`; the sentence says it all. */
  icon?: IconName;
}

/**
 * A quiet panel saying there is nothing here yet, with one way forward.
 *
 * Renders nothing when there is no sentence or no action: a headingless,
 * actionless box would just be empty space, and an actionless "nothing here"
 * is a dead end.
 */
export function EmptyState({
  sentence,
  action,
  icon,
  className,
  ...rest
}: EmptyStateProps): ReactElement | null {
  const hasSentence = typeof sentence === "string" && sentence.trim().length > 0;
  const hasAction =
    action !== null &&
    typeof action === "object" &&
    typeof action.label === "string" &&
    action.label.trim().length > 0;

  if (!hasSentence || !hasAction) return null;

  const actionClass = "sch-empty__action";
  const actionNode =
    action.href !== undefined
      ? createElement(
          "a",
          { className: actionClass, href: action.href, onClick: action.onClick },
          action.label,
        )
      : createElement(
          "button",
          {
            className: actionClass,
            type: "button",
            disabled: action.disabled === true,
            onClick: action.onClick,
          },
          action.label,
        );

  return createElement(
    "div",
    {
      ...rest,
      className: className ? `sch-empty ${className}` : "sch-empty",
    },
    icon
      ? createElement(Icon, { name: icon, className: "sch-empty__icon" })
      : null,
    createElement("p", { className: "sch-empty__sentence" }, sentence),
    actionNode,
  );
}
