import { Component, type ReactNode } from "react";

/** Around the Analytics view only: a failed chunk load or a chart that throws shows one line, and the ward below keeps running. */
export class AnalyticsBoundary extends Component<{ children: ReactNode; onError?: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError?.();
  }
  render() {
    return this.state.failed ? <p className="insights">Could not show analytics</p> : this.props.children;
  }
}
