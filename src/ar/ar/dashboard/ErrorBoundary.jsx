import { Component } from 'react'

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error) {
    return { error }
  }
  componentDidCatch(error, info) {
    console.error('Dashboard render error:', error, info)
  }
  reset = () => this.setState({ error: null })
  render() {
    if (this.state.error) {
      return (
        <div className="dash-error">
          <div>
            <strong>Page crashed:</strong> {this.state.error.message || String(this.state.error)}
            <div style={{ fontSize: 12, marginTop: 6, opacity: 0.8 }}>Open browser DevTools console for full stack.</div>
          </div>
          <button onClick={this.reset}>Retry</button>
        </div>
      )
    }
    return this.props.children
  }
}
