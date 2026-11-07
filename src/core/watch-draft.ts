import {create} from 'zustand';

/**
 * A watch list being made, before it exists.
 *
 * The ＋ used to create the list and then open it, which left a nameless empty list behind
 * whenever someone looked and backed out — and cleaning that up on the way out meant the
 * Overview visibly gained a list and lost it again. Nothing is created now until the first
 * asset is ticked, so there is no list to tidy away and nothing flickers.
 *
 * In a store rather than a route param because the nav-bar title has to see it: that title is a
 * text field, set once through `setOptions` so typing does not remount it and swallow the caret,
 * which means it cannot take changing props. It subscribes here instead.
 *
 * `name` holds what was typed before the list existed — renaming is allowed first, and the name
 * is handed to `add` when the list is finally created, so nothing typed is lost.
 */
type State = {
  drafting: boolean;
  name: string;
  /** Start a draft. The ＋ calls this instead of creating a list. */
  begin: () => void;
  setName: (name: string) => void;
  /** Abandoned, or materialised into a real list. Either way the draft is over. */
  end: () => void;
};

export const useWatchDraft = create<State>((set) => ({
  drafting: false,
  name: '',
  begin: () => set({drafting: true, name: ''}),
  setName: (name) => set({name}),
  end: () => set({drafting: false, name: ''}),
}));
