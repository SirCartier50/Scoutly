declare module 'next-auth' {
  interface Session {
    /** Set only when the Worker rejected/couldn't be reached during the token exchange. */
    cwError?: string
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    /** Career Watch bearer token - server-side only, never copied into Session. */
    cwToken?: string
    cwUserId?: number
    cwError?: string
  }
}

export {}
