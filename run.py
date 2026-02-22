#!/usr/bin/env python3
"""
Launch the Settlers game server.

Usage:
    python run.py              # Start on default port 8000
    python run.py --port 3000  # Start on custom port
"""

import argparse
import uvicorn


def main():
    parser = argparse.ArgumentParser(description="Settlers of Catan — Dynamic Engine")
    parser.add_argument("--host", default="0.0.0.0", help="Host to bind to")
    parser.add_argument("--port", type=int, default=8000, help="Port to bind to")
    parser.add_argument("--reload", action="store_true", help="Enable auto-reload for development")
    args = parser.parse_args()

    print(f"\n  Settlers of Catan — Dynamic Engine")
    print(f"  Starting on http://{args.host}:{args.port}")
    print(f"  Open http://localhost:{args.port} in your browser to play\n")

    uvicorn.run(
        "server.app:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
    )


if __name__ == "__main__":
    main()
