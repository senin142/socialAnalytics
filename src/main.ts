import 'dotenv/config';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
	const app = await NestFactory.create(AppModule);

	app.useGlobalPipes(
		new ValidationPipe({
			whitelist: true,
			transform: true,
		}),
	);

	const allowedOrigins = process.env.CORS_ALLOWED_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean);
	app.enableCors({ origin: allowedOrigins && allowedOrigins.length > 0 ? allowedOrigins : true });

	const port = process.env.PORT || 3000;
	await app.listen(port, () => {
		Logger.log(`Social Analytics service listening on http://localhost:${port}`);
	});
}

bootstrap();
