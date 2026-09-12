import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Patch,
  Post,
  Put,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { CompaniesService } from './companies.service';
import { CreateCompanyDto } from './dto/create-company.dto';
import { UpdateCompanyDto } from './dto/update-company.dto';
import { UploadCertificateDto } from './dto/upload-certificate.dto';

const MAX_PFX_BYTES = 10 * 1024;

@Controller('companies')
export class CompaniesController {
  constructor(private readonly companies: CompaniesService) {}

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateCompanyDto) {
    return this.companies.create(user.id, dto);
  }

  @Get('me')
  findMine(@CurrentUser() user: AuthUser) {
    return this.companies.findMine(user.id);
  }

  @Patch('me')
  update(@CurrentUser() user: AuthUser, @Body() dto: UpdateCompanyDto) {
    return this.companies.update(user.id, dto);
  }

  @Put('me/certificate')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_PFX_BYTES, files: 1 } }))
  setCertificate(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: UploadCertificateDto,
  ) {
    if (!file) throw new BadRequestException('file is required (.pfx)');
    return this.companies.setCertificate(user.id, file.buffer, dto.password);
  }
}
