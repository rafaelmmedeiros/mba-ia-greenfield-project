import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { BEARER_PREFIX } from '../auth.constants';
import { JwtPayload } from '../auth.types';

/**
 * Optional authentication: attaches `request.user` when a valid bearer token is
 * present, proceeds anonymously when no token is supplied, and rejects a token
 * that is present but invalid (mirroring `JwtAuthGuard`'s 401).
 *
 * Used on public reads that behave differently for the owner (e.g. the owner
 * may fetch their own not-yet-`ready` video). The route must also carry
 * `@Public()` so the global `JwtAuthGuard` does not reject anonymous callers.
 */
@Injectable()
export class OptionalJwtAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string>; user?: JwtPayload }>();
    const authHeader = request.headers?.authorization;

    if (!authHeader || !authHeader.startsWith(BEARER_PREFIX)) {
      return true;
    }

    const token = authHeader.slice(BEARER_PREFIX.length);
    try {
      request.user = await this.jwtService.verifyAsync<JwtPayload>(token);
      return true;
    } catch {
      throw new UnauthorizedException();
    }
  }
}
